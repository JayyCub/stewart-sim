/**
 * Low-poly high-wing light aircraft, built from primitives in metres. Model axes: nose toward
 * −z, up +y, right wing +x (the aircraft body axes mapped the same way as NED → three.js, so
 * the sim's attitude quaternion drives it directly). Elevator, ailerons and rudder hinge with
 * the actual surface deflections; the propeller spins with the throttle.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { flight } from "./controller.ts";

const WHITE = "#eef1f4";
const ACCENT = "#1d7f86";
const DARK = "#2a2f36";
const GLASS = "#2d4256";

function Strut({ from, to }: { from: [number, number, number]; to: [number, number, number] }) {
  const { pos, quat, len } = useMemo(() => {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
    const d = b.clone().sub(a);
    return {
      pos: a.clone().add(b).multiplyScalar(0.5),
      quat: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()),
      len: d.length(),
    };
  }, [from, to]);
  return (
    <mesh position={pos} quaternion={quat}>
      <cylinderGeometry args={[0.04, 0.04, len, 5]} />
      <meshStandardMaterial color={WHITE} flatShading />
    </mesh>
  );
}

const Mat = ({ c, rough = 0.6 }: { c: string; rough?: number }) => <meshStandardMaterial color={c} roughness={rough} flatShading />;

export function Airplane() {
  const elevator = useRef<THREE.Group>(null);
  const aileronL = useRef<THREE.Group>(null);
  const aileronR = useRef<THREE.Group>(null);
  const rudder = useRef<THREE.Group>(null);
  const prop = useRef<THREE.Group>(null);

  useFrame((_, dt) => {
    const u = flight.status.tel.controls;
    // Hinges: positive elevator (nose up) lifts the trailing edge; positive aileron (roll right)
    // raises the right aileron and lowers the left; positive rudder (nose right) swings it right.
    if (elevator.current) elevator.current.rotation.x = -u.de;
    if (aileronR.current) aileronR.current.rotation.x = -u.da;
    if (aileronL.current) aileronL.current.rotation.x = u.da;
    if (rudder.current) rudder.current.rotation.y = u.dr;
    if (prop.current && flight.status.running) prop.current.rotation.z += dt * (25 + 55 * u.throttle);
  });

  return (
    <group>
      {/* Fuselage: tapered from cabin to tail */}
      <mesh position={[0, 0, 0.6]} rotation={[-Math.PI / 2, 0, 0]} scale={[0.9, 1, 1.1]}>
        <cylinderGeometry args={[0.62, 0.2, 6.2, 8]} />
        <Mat c={WHITE} />
      </mesh>
      {/* Stripe */}
      <mesh position={[0, -0.05, 0.4]} rotation={[-Math.PI / 2, 0, 0]} scale={[0.92, 1, 0.35]}>
        <cylinderGeometry args={[0.6, 0.24, 5.4, 8, 1, true]} />
        <meshStandardMaterial color={ACCENT} flatShading side={THREE.DoubleSide} />
      </mesh>
      {/* Cowl and spinner */}
      <mesh position={[0, 0, -3.0]} rotation={[-Math.PI / 2, 0, 0]} scale={[0.9, 1, 1.1]}>
        <cylinderGeometry args={[0.45, 0.62, 1.0, 8]} />
        <Mat c={WHITE} />
      </mesh>
      <mesh position={[0, 0, -3.72]} rotation={[-Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.18, 0.45, 8]} />
        <Mat c={ACCENT} />
      </mesh>
      <group ref={prop} position={[0, 0, -3.55]}>
        <mesh>
          <boxGeometry args={[0.13, 1.9, 0.05]} />
          <Mat c={DARK} />
        </mesh>
        <mesh>
          <circleGeometry args={[0.95, 24]} />
          <meshBasicMaterial color={DARK} transparent opacity={0.12} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      </group>
      {/* Cabin glass */}
      <mesh position={[0, 0.42, -1.35]}>
        <boxGeometry args={[1.08, 0.5, 1.5]} />
        <Mat c={GLASS} rough={0.15} />
      </mesh>

      {/* High wing with inner flaps and outer ailerons */}
      <mesh position={[0, 0.82, -0.9]}>
        <boxGeometry args={[11, 0.13, 1.2]} />
        <Mat c={WHITE} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={`tip${s}`} position={[s * 5.45, 0.82, -0.75]}>
          <boxGeometry args={[0.12, 0.15, 1.5]} />
          <Mat c={ACCENT} />
        </mesh>
      ))}
      {[-1, 1].map((s) => (
        <mesh key={`flap${s}`} position={[s * 1.55, 0.82, -0.12]}>
          <boxGeometry args={[2.1, 0.08, 0.36]} />
          <Mat c={WHITE} />
        </mesh>
      ))}
      <group ref={aileronL} position={[-3.95, 0.82, -0.3]}>
        <mesh position={[0, 0, 0.18]}>
          <boxGeometry args={[2.7, 0.08, 0.36]} />
          <Mat c={ACCENT} />
        </mesh>
      </group>
      <group ref={aileronR} position={[3.95, 0.82, -0.3]}>
        <mesh position={[0, 0, 0.18]}>
          <boxGeometry args={[2.7, 0.08, 0.36]} />
          <Mat c={ACCENT} />
        </mesh>
      </group>
      <Strut from={[-0.5, -0.3, -0.8]} to={[-2.7, 0.78, -0.9]} />
      <Strut from={[0.5, -0.3, -0.8]} to={[2.7, 0.78, -0.9]} />

      {/* Tail */}
      <mesh position={[0, 0.12, 3.3]}>
        <boxGeometry args={[3.4, 0.08, 0.7]} />
        <Mat c={WHITE} />
      </mesh>
      <group ref={elevator} position={[0, 0.12, 3.65]}>
        <mesh position={[0, 0, 0.2]}>
          <boxGeometry args={[3.4, 0.06, 0.4]} />
          <Mat c={ACCENT} />
        </mesh>
      </group>
      <mesh position={[0, 0.85, 3.35]}>
        <boxGeometry args={[0.08, 1.35, 0.9]} />
        <Mat c={WHITE} />
      </mesh>
      <group ref={rudder} position={[0, 0.85, 3.8]}>
        <mesh position={[0, 0, 0.2]}>
          <boxGeometry args={[0.06, 1.35, 0.4]} />
          <Mat c={ACCENT} />
        </mesh>
      </group>

      {/* Fixed gear */}
      {[-1, 1].map((s) => (
        <group key={`gear${s}`}>
          <Strut from={[s * 0.4, -0.45, -0.3]} to={[s * 1.1, -0.95, -0.3]} />
          <mesh position={[s * 1.15, -0.98, -0.3]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.27, 0.27, 0.16, 10]} />
            <Mat c={DARK} />
          </mesh>
        </group>
      ))}
      <Strut from={[0, -0.4, -2.8]} to={[0, -0.95, -2.9]} />
      <mesh position={[0, -0.98, -2.9]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.22, 0.22, 0.13, 10]} />
        <Mat c={DARK} />
      </mesh>
    </group>
  );
}
