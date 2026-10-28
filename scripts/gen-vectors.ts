/**
 * Generates test-vectors/ik-v1.json from the TypeScript kinematics core.
 *
 * These are golden values: the TS solver's own unit tests prove every
 * solution satisfies the rod and horn length constraints, and the C++ port
 * in firmware/ must reproduce these angles within `toleranceRad`.
 *
 * Run: pnpm vectors
 */
import { writeFileSync } from "node:fs";
import { DEG, buildLayout, solve } from "../packages/kinematics/src/index.ts";
import type { Pose } from "../packages/kinematics/src/index.ts";
import { defaultRig } from "../packages/rig-config/src/index.ts";

const g = defaultRig.geometry, lim = defaultRig.limits;
const layout = buildLayout(g);
const P = (name: string, p: Partial<Pose>) => ({ name, pose: { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0, ...p } });

let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5);

const poses = [
  P("home", {}),
  P("heave up 10", { z: 10 }),
  P("heave down 10", { z: -10 }),
  P("surge +15", { x: 15 }),
  P("sway -15", { y: -15 }),
  P("roll +10deg", { roll: 10 * DEG }),
  P("pitch -10deg", { pitch: -10 * DEG }),
  P("yaw +20deg", { yaw: 20 * DEG }),
  P("combined", { x: 5, y: -4, z: 6, roll: 4 * DEG, pitch: -3 * DEG, yaw: 8 * DEG }),
  P("unreachable", { z: 200 }),
  ...Array.from({ length: 24 }, (_, i) =>
    P(`random ${i}`, { x: rnd() * 30, y: rnd() * 30, z: rnd() * 20, roll: rnd() * 20 * DEG, pitch: rnd() * 20 * DEG, yaw: rnd() * 40 * DEG })),
];

const cases = poses.map(({ name, pose }) => {
  const sol = solve(layout, g, lim, pose);
  return {
    name,
    pose,
    ok: sol.ok,
    alphaRad: sol.legs.map((l) => (Number.isNaN(l.alpha) ? null : Number(l.alpha.toFixed(12)))),
    faults: sol.legs.map((l) => l.faults),
  };
});

const out = {
  version: 1,
  description: "Pose (mm, rad; R = Rz(yaw)Ry(pitch)Rx(roll)) to horn angle alpha per leg (rad, from horizontal). null = no solution.",
  toleranceRad: 1e-6,
  geometry: g,
  limits: lim,
  homeHeight: Number(layout.homeHeight.toFixed(12)),
  cases,
};

writeFileSync(new URL("../test-vectors/ik-v1.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${cases.length} cases (${cases.filter((c) => c.ok).length} fully valid)`);
