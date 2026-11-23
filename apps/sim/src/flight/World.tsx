/**
 * The flight game's 3D world: endless procedural terrain (re-centred under the aircraft as it
 * flies), lakes, forests, clouds, sky, the aircraft, and the chase / cockpit cameras.
 *
 * Frames: the flight model is NED (x north, y east, z down). three.js here is x east, y up,
 * z south. Both are right-handed and the same map turns body axes into the Airplane model's
 * axes, so the attitude quaternion converts as (w, x, y, z)_NED → (w, y, −z, −x)_three.
 */
import { Sky } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { fbm, rawHeight } from "@stewart/flight";
import { Airplane } from "./Airplane.tsx";
import { flight } from "./controller.ts";

export type CameraMode = "chase" | "cockpit";

const SIZE = 26000;
const SEG = 260; // 100 m cells
const CELL = SIZE / SEG;
const FOG = "#c4d7e8";

/** NED position → three.js position. */
const toThree = (p: readonly number[], out = new THREE.Vector3()) => out.set(p[1]!, -p[2]!, -p[0]!);
const toThreeQuat = (q: readonly number[], out = new THREE.Quaternion()) => out.set(q[2]!, -q[3]!, -q[1]!, q[0]!);

function hash2(a: number, b: number): number {
  let h = Math.imul(a, 73856093) ^ Math.imul(b, 19349663);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

const FIELDS = ["#86ab55", "#98b85c", "#739f49", "#b8b16a", "#8bb153", "#a7a85f"].map((c) => new THREE.Color(c));
const SAND = new THREE.Color("#d6c78f");
const BED = new THREE.Color("#a99a6c");
const FOREST = new THREE.Color("#4d7639");
const ROCK = new THREE.Color("#8b8579");
const SNOW = new THREE.Color("#f3f4f2");

function groundColor(h: number, north: number, east: number, out: THREE.Color): THREE.Color {
  if (h < 0) return out.copy(BED);
  if (h < 14) return out.copy(SAND);
  const field = FIELDS[Math.floor(hash2(Math.floor(north / 520), Math.floor(east / 520)) * FIELDS.length)]!;
  if (h < 260) return out.copy(field).lerp(FOREST, Math.max(0, (h - 120) / 140) * 0.8);
  if (h < 520) return out.copy(FOREST).lerp(ROCK, Math.max(0, (h - 420) / 100));
  if (h < 690) return out.copy(ROCK);
  return out.copy(ROCK).lerp(SNOW, Math.min(1, (h - 690) / 60));
}

/** True where a forest grows (used for the tree instances). */
const forestAt = (h: number, north: number, east: number) => h > 40 && h < 560 && fbm(east / 1800, north / 1800, 3, 21) > 0.55;

function Terrain() {
  const mesh = useRef<THREE.Mesh>(null);
  const centre = useRef<[number, number] | null>(null);
  const geom = useMemo(() => {
    const g = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    g.rotateX(-Math.PI / 2);
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(g.attributes.position!.count * 3), 3));
    return g;
  }, []);

  const rebuild = (cx: number, cz: number) => {
    const pos = geom.attributes.position as THREE.BufferAttribute;
    const col = geom.attributes.color as THREE.BufferAttribute;
    const c = new THREE.Color();
    // Fixed local x/z from the PlaneGeometry; heights sampled at world coordinates.
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + cx, z = pos.getZ(i) + cz;
      const north = -z, east = x;
      const raw = rawHeight(north, east);
      pos.setY(i, raw < 0 ? Math.max(raw, -25) - 2 : raw);
      groundColor(raw, north, east, c);
      const j = 0.94 + 0.12 * hash2(Math.round(x / CELL), Math.round(z / CELL));
      col.setXYZ(i, c.r * j, c.g * j, c.b * j);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    geom.computeVertexNormals();
    geom.computeBoundingSphere();
    mesh.current?.position.set(cx, 0, cz);
  };

  useFrame(() => {
    const p = toThree(flight.status.tel.state.pos);
    const c = centre.current;
    if (!c || Math.hypot(p.x - c[0], p.z - c[1]) > 2500) {
      const cx = Math.round(p.x / CELL) * CELL, cz = Math.round(p.z / CELL) * CELL;
      centre.current = [cx, cz];
      rebuild(cx, cz);
    }
  });

  useEffect(() => () => geom.dispose(), [geom]);
  return (
    <mesh ref={mesh} geometry={geom}>
      <meshLambertMaterial vertexColors flatShading />
    </mesh>
  );
}

function Water() {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const p = toThree(flight.status.tel.state.pos);
    ref.current?.position.set(p.x, 0.6, p.z);
  });
  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[SIZE, SIZE]} />
      <meshLambertMaterial color="#4a86b5" />
    </mesh>
  );
}

/** Instances regenerated around the aircraft whenever it has moved `every` metres. */
function useScatter(every: number, build: (cx: number, cz: number, m: THREE.InstancedMesh) => number) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const centre = useRef<[number, number] | null>(null);
  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    const p = toThree(flight.status.tel.state.pos);
    const c = centre.current;
    if (!c || Math.hypot(p.x - c[0], p.z - c[1]) > every) {
      centre.current = [p.x, p.z];
      m.count = build(p.x, p.z, m);
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    }
  });
  return ref;
}

const MAX_TREES = 6000;
function Trees() {
  const o = useMemo(() => new THREE.Object3D(), []);
  const ref = useScatter(700, (cx, cz, m) => {
    const step = 110, r = 3200;
    let n = 0;
    for (let gx = Math.floor((cx - r) / step); gx <= (cx + r) / step && n < MAX_TREES; gx++) {
      for (let gz = Math.floor((cz - r) / step); gz <= (cz + r) / step && n < MAX_TREES; gz++) {
        const jx = hash2(gx, gz), jz = hash2(gz, gx + 7);
        const x = (gx + jx) * step, z = (gz + jz) * step;
        const north = -z, east = x;
        const h = rawHeight(north, east);
        if (!forestAt(h, north, east)) continue;
        const s = 10 + 12 * hash2(gx + 3, gz - 5);
        o.position.set(x, h + s * 0.45, z);
        o.scale.set(s * 0.38, s, s * 0.38);
        o.updateMatrix();
        m.setMatrixAt(n++, o.matrix);
      }
    }
    return n;
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, MAX_TREES]} frustumCulled={false}>
      <coneGeometry args={[1, 1, 5]} />
      <meshLambertMaterial color="#365f2c" flatShading />
    </instancedMesh>
  );
}

const MAX_PUFFS = 1400;
function Clouds() {
  const o = useMemo(() => new THREE.Object3D(), []);
  const ref = useScatter(2500, (cx, cz, m) => {
    const step = 1700, r = 15000;
    let n = 0;
    for (let gx = Math.floor((cx - r) / step); gx <= (cx + r) / step; gx++) {
      for (let gz = Math.floor((cz - r) / step); gz <= (cz + r) / step; gz++) {
        if (hash2(gx * 3 + 1, gz * 5 + 2) > 0.38) continue;
        const bx = (gx + hash2(gx, gz + 11)) * step, bz = (gz + hash2(gx + 13, gz)) * step;
        const by = 1500 + 700 * hash2(gx - 4, gz + 9);
        const puffs = 4 + Math.floor(5 * hash2(gx + 8, gz + 8));
        for (let k = 0; k < puffs && n < MAX_PUFFS; k++) {
          const s = 70 + 110 * hash2(gx * 7 + k, gz * 3 - k);
          o.position.set(bx + (hash2(k, gx) - 0.5) * 420, by + (hash2(gz, k) - 0.3) * 70, bz + (hash2(k + 5, gz) - 0.5) * 300);
          o.scale.set(s * 1.4, s * 0.7, s);
          o.updateMatrix();
          m.setMatrixAt(n++, o.matrix);
        }
      }
    }
    return n;
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, MAX_PUFFS]} frustumCulled={false}>
      <icosahedronGeometry args={[1, 1]} />
      <meshLambertMaterial color="#ffffff" emissive="#dfe6ee" emissiveIntensity={0.62} flatShading />
    </instancedMesh>
  );
}

function PlaneAndCamera({ mode }: { mode: CameraMode }) {
  const plane = useRef<THREE.Group>(null);
  const { camera } = useThree();
  const tmp = useMemo(() => ({ p: new THREE.Vector3(), q: new THREE.Quaternion(), want: new THREE.Vector3(), look: new THREE.Vector3(), fwd: new THREE.Vector3() }), []);
  const first = useRef(true);

  useEffect(() => {
    first.current = true;
  }, [mode]);

  useFrame((_, dt) => {
    const tel = flight.status.tel;
    const { p, q, want, look, fwd } = tmp;
    toThree(tel.state.pos, p);
    toThreeQuat(tel.state.q, q);
    plane.current?.position.copy(p);
    plane.current?.quaternion.copy(q);
    // The model's cabin is too small to sit in, so cockpit view hides it; the HUD draws a fixed aircraft symbol instead.
    if (plane.current) plane.current.visible = mode === "chase";

    if (mode === "cockpit") {
      // Pilot's eye: left seat.
      camera.position.copy(p).add(new THREE.Vector3(-0.3, 0.7, -0.9).applyQuaternion(q));
      camera.quaternion.copy(q);
      return;
    }
    // Chase: behind and above along the heading, world-up, so the aircraft's bank stays visible.
    const psi = tel.euler[2];
    fwd.set(Math.sin(psi), 0, -Math.cos(psi));
    want.copy(p).addScaledVector(fwd, -24).add(new THREE.Vector3(0, 6.5, 0));
    const k = first.current ? 1 : 1 - Math.exp(-dt * 5);
    first.current = false;
    camera.position.lerp(want, k);
    look.copy(p).addScaledVector(fwd, 10).add(new THREE.Vector3(0, 1.5, 0));
    camera.up.set(0, 1, 0);
    camera.lookAt(look);
  });

  return (
    <group ref={plane}>
      <Airplane />
    </group>
  );
}

export function World({ mode }: { mode: CameraMode }) {
  const { scene } = useThree();
  useEffect(() => {
    scene.fog = new THREE.Fog(FOG, 2500, 15000);
    scene.background = new THREE.Color(FOG);
    return () => {
      scene.fog = null;
    };
  }, [scene]);
  return (
    <>
      <Sky distance={400000} sunPosition={[0.6, 0.45, -0.4]} turbidity={5} rayleigh={1.1} mieCoefficient={0.004} />
      <hemisphereLight args={["#dfeeff", "#6b7a4e", 0.9]} />
      <directionalLight position={[0.6, 0.45, -0.4]} intensity={1.8} />
      <Terrain />
      <Water />
      <Trees />
      <Clouds />
      <PlaneAndCamera mode={mode} />
    </>
  );
}
