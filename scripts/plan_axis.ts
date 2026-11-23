/**
 * Plans a single-axis platform motion for the bench scripts (scripts/surge, scripts/sway).
 *
 * Solves IK with the shared kinematics and rig.json for evenly spaced poses along one
 * axis, from -amplitude to +amplitude, and checks every pose (servo range, ball-joint
 * swivel, collisions). Prints a lookup table of horn angles as JSON on stdout. Any pose
 * the runner can command (ramp-in, steady wave, ease back to home) lies on that segment,
 * so the whole motion is validated before the first frame is sent.
 *
 * Run: node --experimental-strip-types scripts/plan_axis.ts AXIS AMPLITUDE [--ignore-limits]
 *   AXIS       x | y | z | roll | pitch | yaw
 *   AMPLITUDE  mm for x/y/z, degrees for roll/pitch/yaw
 *   --ignore-limits  turn servo-range, swivel and collision faults into warnings
 *                    (a pose with no IK solution is always refused)
 *
 * Exit 0 with {ok: true, ...}; exit 2 with {ok: false, error} when refused.
 */
import { AXES, DEG, axisReach, buildLayout, solve } from "../packages/kinematics/src/index.ts";
import type { Axis, LegFault, Pose } from "../packages/kinematics/src/index.ts";
import { defaultRig, servoLabel } from "../packages/rig-config/src/index.ts";

const SAMPLES = 401; // odd, so the table has an exact home sample in the middle
const ROTATIONS: readonly Axis[] = ["roll", "pitch", "yaw"];

function fail(error: string): never {
  console.log(JSON.stringify({ ok: false, error }));
  process.exit(2);
}

const args = process.argv.slice(2);
const ignoreLimits = args.includes("--ignore-limits");
const [axisArg, ampArg] = args.filter((a) => !a.startsWith("--"));
const axis = axisArg as Axis;
if (!AXES.includes(axis)) fail(`axis must be one of ${AXES.join(", ")}`);
const amplitude = Number(ampArg);
if (!(amplitude > 0)) fail("amplitude must be a positive number");

const isRot = ROTATIONS.includes(axis);
const unit = isRot ? "deg" : "mm";
const toPose = (v: number) => (isRot ? v * DEG : v); // CLI value -> kinematics units

const { geometry: g, limits: lim, collision: col } = defaultRig;
const layout = buildLayout(g);
const home: Pose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };

const reachText = () => {
  const r = axisReach(layout, g, lim, axis, col);
  const k = isRot ? 1 / DEG : 1;
  return `with the current rig.json, ${axis} reaches ${(r.min * k).toFixed(1)} to +${(r.max * k).toFixed(1)} ${unit}`;
};

const samples: number[] = [];
const alphaDeg: number[][] = [];
const warnings = new Map<LegFault, string>(); // first occurrence of each overridden fault
for (let k = 0; k < SAMPLES; k++) {
  const v = -amplitude + (2 * amplitude * k) / (SAMPLES - 1);
  const sol = solve(layout, g, lim, { ...home, [axis]: toPose(v) }, col);
  const where = `${axis} = ${v.toFixed(2)} ${unit}`;
  sol.legs.forEach((leg, i) => {
    if (Number.isNaN(leg.alpha)) fail(`${where}: servo ${servoLabel(defaultRig, i)} has no IK solution (cannot be overridden); ${reachText()}`);
    for (const f of leg.faults) {
      const msg = `${where}: servo ${servoLabel(defaultRig, i)} ${f}`;
      if (!ignoreLimits) fail(`${msg}; ${reachText()}`);
      if (!warnings.has(f)) warnings.set(f, msg);
    }
  });
  samples.push(v);
  alphaDeg.push(sol.legs.map((l) => l.alpha / DEG));
}

// Steepest horn-angle change per unit of motion, for the runner's speed limit.
let maxSlope = 0;
for (let k = 1; k < SAMPLES; k++) {
  const dv = samples[k] - samples[k - 1];
  for (let i = 0; i < 6; i++) maxSlope = Math.max(maxSlope, Math.abs(alphaDeg[k][i] - alphaDeg[k - 1][i]) / dv);
}

console.log(JSON.stringify({
  ok: true,
  axis,
  unit,
  amplitude,
  measured: defaultRig.measured,
  samples,
  alphaDeg,
  maxSlopeDegPerUnit: maxSlope,
  warnings: [...warnings.values()],
}));
