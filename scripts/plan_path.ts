/**
 * Plans a periodic multi-axis path for the bench scripts (circle, figure8, lissajous).
 *
 * The path is a sum of sines, one per axis: q(phi) = amp * sin(harmonic * phi + phase).
 * The runner plays s * q(phi) with phi advancing 2*pi per period and s ramping 0 -> 1 at
 * the start and 1 -> 0 on stop, so every pose it can command lies on the surface
 * { s * q(phi) : s in [0, 1], phi in [0, 2*pi) }. This planner solves IK with the shared
 * kinematics and rig.json on a (s, phi) grid over that whole surface, checks every pose
 * (servo range, ball-joint swivel, collisions), and prints the horn-angle table as JSON.
 *
 * Run: node --experimental-strip-types scripts/plan_path.ts '<spec json>' [--ignore-limits]
 *   spec: {"x": [amp, harmonic, phaseDeg], "roll": [...], ...}
 *         x/y/z amplitudes in mm, roll/pitch/yaw in degrees; harmonic a whole number 1..6.
 *   --ignore-limits  turn servo-range, swivel and collision faults into warnings
 *                    (a pose with no IK solution is always refused)
 *
 * Exit 0 with {ok: true, ...}; exit 2 with {ok: false, error, fitsScale} when refused,
 * where fitsScale is the largest multiplier of every amplitude whose full path passes.
 */
import { AXES, DEG, buildLayout, solve } from "../packages/kinematics/src/index.ts";
import type { Axis, LegFault, Pose } from "../packages/kinematics/src/index.ts";
import { defaultRig, servoLabel } from "../packages/rig-config/src/index.ts";

const RINGS = 40; // steps in s, home to full size
const SPOKES = 360; // 1 degree steps in phase (fine enough for harmonics up to 6)
const ROTATIONS: readonly Axis[] = ["roll", "pitch", "yaw"];

type Term = { axis: Axis; amp: number; harmonic: number; phase: number };

function fail(error: string, fitsScale?: number): never {
  console.log(JSON.stringify({ ok: false, error, fitsScale }));
  process.exit(2);
}

const args = process.argv.slice(2);
const ignoreLimits = args.includes("--ignore-limits");
let raw: Record<string, unknown>;
try {
  raw = JSON.parse(args.find((a) => !a.startsWith("--")) ?? "");
} catch {
  fail("spec must be JSON like {\"x\": [20, 1, 0]}");
}
const terms: Term[] = [];
for (const [axis, v] of Object.entries(raw)) {
  if (!AXES.includes(axis as Axis)) fail(`unknown axis ${axis}; use ${AXES.join(", ")}`);
  const [amp, harmonic = 1, phaseDeg = 0] = Array.isArray(v) ? v : [v];
  if (!(typeof amp === "number" && amp >= 0)) fail(`${axis}: amplitude must be a number >= 0`);
  if (!(Number.isInteger(harmonic) && harmonic >= 1 && harmonic <= 6)) fail(`${axis}: harmonic must be a whole number 1..6`);
  if (typeof phaseDeg !== "number") fail(`${axis}: phase must be a number of degrees`);
  if (amp > 0) terms.push({ axis: axis as Axis, amp, harmonic, phase: phaseDeg * DEG });
}
if (!terms.length) fail("spec has no axis with a non-zero amplitude");

const { geometry: g, limits: lim, collision: col } = defaultRig;
const layout = buildLayout(g);

/** Pose at size s and phase phi, with every amplitude multiplied by k. */
function poseAt(s: number, phi: number, k = 1): Pose {
  const p: Pose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };
  for (const t of terms) {
    const v = k * s * t.amp * Math.sin(t.harmonic * phi + t.phase);
    p[t.axis] += ROTATIONS.includes(t.axis) ? v * DEG : v;
  }
  return p;
}

/** Largest multiplier of all amplitudes whose whole path (every s and phi) passes, to 0.5%. */
function largestScale(): number {
  const fits = (k: number) => {
    for (let r = 1; r <= RINGS; r += 3) // a coarser grid is enough for the advice
      for (let j = 0; j < SPOKES; j += 2)
        if (!solve(layout, g, lim, poseAt(r / RINGS, (2 * Math.PI * j) / SPOKES, k), col).ok) return false;
    return true;
  };
  let lo = 0, hi = 1;
  while (hi - lo > 0.005) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

const alphaDeg: number[][][] = []; // [ring][spoke] -> six horn angles, degrees
const warnings = new Map<LegFault, string>();
for (let r = 0; r <= RINGS; r++) {
  const s = r / RINGS;
  const ring: number[][] = [];
  for (let j = 0; j < SPOKES; j++) {
    const phi = (2 * Math.PI * j) / SPOKES;
    const sol = solve(layout, g, lim, poseAt(s, phi), col);
    const where = `${Math.round(s * 100)}% size at phase ${j * (360 / SPOKES)} deg`;
    for (const [i, leg] of sol.legs.entries()) {
      if (Number.isNaN(leg.alpha)) {
        const k = largestScale();
        fail(`${where}: servo ${servoLabel(defaultRig, i)} has no IK solution (cannot be overridden); the path fits at ${(k * 100).toFixed(0)}% of the requested amplitudes`, k);
      }
      for (const f of leg.faults) {
        const msg = `${where}: servo ${servoLabel(defaultRig, i)} ${f}`;
        if (!ignoreLimits) {
          const k = largestScale();
          fail(`${msg}; the path fits at ${(k * 100).toFixed(0)}% of the requested amplitudes`, k);
        }
        if (!warnings.has(f)) warnings.set(f, msg);
      }
    }
    ring.push(sol.legs.map((l) => l.alpha / DEG));
  }
  alphaDeg.push(ring);
}

// Angle at the bottom ball between horn and rod on the full-size path, per spoke and leg:
// what the rod-hits-horn check compares with collision.hornRodMinDeg. Printed by --hold-at
// so the real rig can be compared with the model.
const sub = (a: readonly number[], b: readonly number[]) => a.map((v, i) => v - b[i]!);
const angleDeg = (a: number[], b: number[]) =>
  Math.acos(Math.min(1, Math.max(-1, a.reduce((t, v, i) => t + v * b[i]!, 0) / (Math.hypot(...a) * Math.hypot(...b))))) / DEG;
const outerHornRodDeg: number[][] = [];
for (let j = 0; j < SPOKES; j++) {
  const sol = solve(layout, g, lim, poseAt(1, (2 * Math.PI * j) / SPOKES), col);
  outerHornRodDeg.push(sol.legs.map((l) => angleDeg(sub(l.pivot, l.hornTip), sub(l.top, l.hornTip))));
}

// Steepest horn-angle change per radian of phase on the full-size path, for the speed check.
let maxDegPerRad = 0;
const outer = alphaDeg[RINGS]!;
const dphi = (2 * Math.PI) / SPOKES;
for (let j = 0; j < SPOKES; j++) {
  const a = outer[j]!, b = outer[(j + 1) % SPOKES]!;
  for (let i = 0; i < 6; i++) maxDegPerRad = Math.max(maxDegPerRad, Math.abs(b[i]! - a[i]!) / dphi);
}

console.log(JSON.stringify({
  ok: true,
  rings: RINGS,
  spokes: SPOKES,
  measured: defaultRig.measured,
  alphaDeg,
  maxDegPerRad,
  outerHornRodDeg,
  hornRodMinDeg: col.hornRodMinDeg,
  warnings: [...warnings.values()],
}));
