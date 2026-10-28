import { useMemo } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { Grid, Html, OrbitControls } from "@react-three/drei";
import { Euler, Quaternion, Vector3 } from "three";
import type { Vec3 } from "@stewart/kinematics";
import { useSim } from "./store.ts";

/** Colours chosen to read on both the light and dark viewport. */
const C = {
  plywood: "#c8a878",
  plywoodEdge: "#a88a5c",
  servo: "#2b3038",
  horn: "#e9e7e2",
  rod: "#9aa4ae",
  ball: "#b8c0c8",
  fault: "#e0453a",
};

/** MG996R body, mm: 40.7 long (mounted vertical), 19.7 wide, 42.9 deep. Shaft sits about 10 mm below the top end. */
const SERVO = { len: 40.7, wide: 19.7, deep: 42.9, shaftFromTop: 10 };
const BASE_TOP_Z = -(SERVO.len - SERVO.shaftFromTop);
const Y_UP = new Vector3(0, 1, 0);

function Segment({ a, b, r, color }: { a: Vec3; b: Vec3; r: number; color: string }) {
  const { mid, len, quat } = useMemo(() => {
    const va = new Vector3(...a), vb = new Vector3(...b);
    const d = vb.clone().sub(va);
    return {
      mid: va.clone().add(vb).multiplyScalar(0.5),
      len: d.length(),
      quat: new Quaternion().setFromUnitVectors(Y_UP, d.clone().normalize()),
    };
  }, [a, b]);
  return (
    <mesh position={mid} quaternion={quat}>
      <cylinderGeometry args={[r, r, len, 16]} />
      <meshStandardMaterial color={color} metalness={0.3} roughness={0.5} />
    </mesh>
  );
}

function Ball({ p, color }: { p: Vec3; color: string }) {
  return (
    <mesh position={p as unknown as [number, number, number]}>
      <sphereGeometry args={[3.2, 20, 14]} />
      <meshStandardMaterial color={color} metalness={0.6} roughness={0.3} />
    </mesh>
  );
}

function Rig() {
  const { geometry, layout, solution, pose } = useSim();
  if (!Number.isFinite(layout.homeHeight)) return null;

  const T: [number, number, number] = [pose.x, pose.y, layout.homeHeight + pose.z];
  const rot = new Euler(pose.roll, pose.pitch, pose.yaw, "ZYX");
  const baseR = geometry.baseRadius + 22;
  const topR = geometry.platformRadius + 14;

  return (
    <group>
      {/* Base plate: 6 mm plywood under the servos. */}
      <mesh position={[0, 0, BASE_TOP_Z - 3]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[baseR, baseR, 6, 72]} />
        <meshStandardMaterial color={C.plywood} roughness={0.85} />
      </mesh>

      {layout.base.map((B, i) => {
        const theta = Math.atan2(B[1], B[0]);
        const leg = solution.legs[i]!;
        const bad = leg.faults.length > 0;
        // Servo body sits radially inward of the horn plane, centred on the pivot tangentially.
        const inward = 3 + SERVO.deep / 2;
        const zc = BASE_TOP_Z + SERVO.len / 2;
        return (
          <group key={i}>
            <mesh position={[B[0] - Math.cos(theta) * inward, B[1] - Math.sin(theta) * inward, zc]} rotation={[0, 0, theta]}>
              <boxGeometry args={[SERVO.deep, SERVO.wide, SERVO.len]} />
              <meshStandardMaterial color={C.servo} roughness={0.6} />
            </mesh>
            {!leg.faults.includes("no-solution") && (
              <>
                <Segment a={leg.pivot} b={leg.hornTip} r={2.6} color={bad ? C.fault : C.horn} />
                <Segment a={leg.hornTip} b={leg.top} r={1.5} color={bad ? C.fault : C.rod} />
                <Ball p={leg.hornTip} color={bad ? C.fault : C.ball} />
                <Ball p={leg.top} color={bad ? C.fault : C.ball} />
              </>
            )}
            <Html position={[B[0] * 1.32, B[1] * 1.32, BASE_TOP_Z]} center zIndexRange={[10, 0]}>
              <span className={`leg-tag${bad ? " bad" : ""}`}>{i + 1}</span>
            </Html>
          </group>
        );
      })}

      {/* Top plate in the platform frame; joints hang 4 mm below it. */}
      <group position={T} rotation={rot}>
        <mesh position={[0, 0, 7]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[topR, topR, 6, 72]} />
          <meshStandardMaterial color={C.plywood} roughness={0.85} />
        </mesh>
        <mesh position={[topR * 0.7, 0, 10.2]}>
          <boxGeometry args={[14, 4, 0.6]} />
          <meshStandardMaterial color={C.plywoodEdge} />
        </mesh>
      </group>
    </group>
  );
}

/** Back the camera off on narrow (portrait) viewports so the whole rig stays in frame. */
function FitCamera() {
  const { camera, size } = useThree();
  useEffect(() => {
    const aspect = size.width / Math.max(1, size.height);
    const k = aspect < 1 ? 1.15 / aspect : 1;
    camera.position.set(300 * k, 230 * k, 300 * k);
    camera.updateProjectionMatrix();
  }, [camera, size.width, size.height]);
  return null;
}

export function RigView() {
  return (
    <Canvas camera={{ position: [300, 230, 300], fov: 35, near: 1, far: 5000 }} gl={{ alpha: true, antialias: true }} dpr={[1, 2]}>
      <FitCamera />
      <ambientLight intensity={0.9} />
      <directionalLight position={[200, 400, 150]} intensity={1.6} />
      <directionalLight position={[-250, 150, -200]} intensity={0.5} />
      {/* Kinematics is z-up; three.js is y-up. */}
      <group rotation={[-Math.PI / 2, 0, 0]}>
        <Rig />
      </group>
      <Grid
        position={[0, BASE_TOP_Z - 6.1, 0]}
        args={[600, 600]}
        cellSize={10}
        sectionSize={50}
        cellColor="#8a94a0"
        sectionColor="#6c7784"
        cellThickness={0.5}
        sectionThickness={1}
        fadeDistance={700}
        fadeStrength={1.5}
        infiniteGrid
      />
      <OrbitControls target={[0, 40, 0]} makeDefault enableDamping />
    </Canvas>
  );
}
