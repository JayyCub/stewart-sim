import { describe, expect, it } from "vitest";
import {
  AXES, DEFAULT_COLLISION as C, DEG, G, buildLayout, decode, differentialEvolution, encode, evaluateDesign, legTorques,
  optimizeDesign, patternSearch, scoreGeometry, solve, weightedReachScore, workspace,
  type DesignGoal, type Geometry, type Limits, type Pose,
} from "../src/index.ts";

const geo: Geometry = {
  baseRadius: 85, platformRadius: 60, baseHalfAngleDeg: 15, platformHalfAngleDeg: 30, hornLength: 22, rodLength: 120,
};
const lim: Limits = { servoMinDeg: -70, servoMaxDeg: 70, ballSwivelDeg: 30 };
const layout = buildLayout(geo);
const pose = (p: Partial<Pose> = {}): Pose => ({ x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0, ...p });
const equal = { x: 1, y: 1, z: 1, roll: 1, pitch: 1, yaw: 1 };
const goal: DesignGoal = { weights: equal, payloadKg: 1, torqueLimitNmm: 1e9 };

describe("servo torques", () => {
  const sol = solve(layout, geo, lim, pose());
  const t = legTorques(layout, sol, pose(), 1)!;

  it("share a centred load equally at home on a symmetric rig", () => {
    for (const v of t) expect(Math.abs(v)).toBeCloseTo(Math.abs(t[0]!), 6);
    expect(Math.abs(t[0]!)).toBeGreaterThan(0);
  });

  it("balance the payload's weight", () => {
    // Recover rod forces from torque: τ = r × (−f d) · u. Check vertical equilibrium via the solver's own system instead:
    // doubling the payload doubles every torque, and zero payload needs none.
    const t2 = legTorques(layout, sol, pose(), 2)!;
    t.forEach((v, i) => expect(t2[i]!).toBeCloseTo(2 * v, 6));
    expect(legTorques(layout, sol, pose(), 0)!.every((v) => Math.abs(v) < 1e-9)).toBe(true);
  });

  it("are about weight × horn length / 6 for level horns and near-vertical rods", () => {
    const rough = (G * 22) / 6; // N·mm for 1 kg
    expect(Math.abs(t[0]!)).toBeGreaterThan(rough * 0.8);
    expect(Math.abs(t[0]!)).toBeLessThan(rough * 1.5);
  });

  it("agree with virtual work through the IK Jacobian, away from home too", () => {
    // Independent check. Positive alpha turns horn i about det_i · shaftAxis, where
    // det_i = (shaft × hornDir) · hornUp is ±1 (mirrored servos are left-handed). For any small motion the
    // servos' work balances gravity's, so Jᵀ(det ∘ τ) = (0, 0, ±m g, 0, 0, 0) with J = ∂α/∂pose.
    const open: Limits = { servoMinDeg: -89, servoMaxDeg: 89, ballSwivelDeg: 89 };
    const cross = (a: readonly number[], b: readonly number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
    const det = layout.shaftAxis.map((u, i) => cross(u, layout.hornDir[i]!).reduce((s, v, k) => s + v * layout.hornUp[i]![k]!, 0));
    const alphas = (p: Pose) => solve(layout, geo, open, p).legs.map((l) => l.alpha);
    for (const p of [pose(), pose({ x: 15 }), pose({ y: -20 }), pose({ yaw: 0.3, z: 5 }), pose({ roll: 0.15, pitch: -0.1 })]) {
      const h = 1e-6;
      const tau = legTorques(layout, solve(layout, geo, open, p), p, 1)!;
      const gen = AXES.map((ax) => {
        const a = alphas({ ...p, [ax]: p[ax] + h }), b = alphas({ ...p, [ax]: p[ax] - h });
        return a.reduce((s, v, i) => s + ((v - b[i]!) / (2 * h)) * det[i]! * tau[i]!, 0);
      });
      expect(Math.abs(gen[2]!)).toBeCloseTo(G, 4);
      for (const k of [0, 1, 3, 4, 5]) expect(Math.abs(gen[k]!)).toBeLessThan(1e-3);
    }
  });

  it("returns null for an unreachable pose", () => {
    expect(legTorques(layout, solve(layout, geo, lim, pose({ z: 200 })), pose({ z: 200 }), 1)).toBeNull();
  });
});

describe("weighted score", () => {
  const reach = workspace(layout, geo, lim, C);

  it("matches the sweep score with equal weights", () => {
    expect(weightedReachScore(reach, equal)).toBeCloseTo(scoreGeometry(geo, lim, C).score, 12);
  });

  it("ignores axes with zero weight", () => {
    const only = (ax: keyof typeof equal) => ({ ...Object.fromEntries(AXES.map((a) => [a, 0])), [ax]: 1 }) as typeof equal;
    const yawOnly = weightedReachScore(reach, only("yaw"));
    expect(yawOnly).toBeCloseTo((reach.yaw.max - reach.yaw.min) / (60 * DEG), 12);
  });
});

describe("design evaluation", () => {
  it("penalises designs the servos can't hold", () => {
    const free = evaluateDesign(geo, lim, C, goal);
    const tight = evaluateDesign(geo, lim, C, { ...goal, torqueLimitNmm: free.maxTorqueNmm / 2 });
    expect(free.score).toBeCloseTo(free.reachScore, 12);
    expect(tight.score).toBeCloseTo(free.reachScore / 16, 9);
  });

  it("scores clashing servos as zero", () => {
    expect(evaluateDesign({ ...geo, baseHalfAngleDeg: 10 }, lim, C, goal).score).toBe(0);
  });
});

describe("search", () => {
  // A smooth bump with its peak at (0.3, 0.7, 0.5).
  const bump = (x: number[]) => -((x[0]! - 0.3) ** 2 + (x[1]! - 0.7) ** 2 + (x[2]! - 0.5) ** 2);

  it("differential evolution finds the peak", () => {
    const r = differentialEvolution(3, bump, { population: 20, generations: 60, seed: 3 });
    expect(r.x[0]).toBeCloseTo(0.3, 2);
    expect(r.x[1]).toBeCloseTo(0.7, 2);
  });

  it("is repeatable for a seed", () => {
    const a = differentialEvolution(3, bump, { population: 10, generations: 5, seed: 9 });
    const b = differentialEvolution(3, bump, { population: 10, generations: 5, seed: 9 });
    expect(a).toEqual(b);
  });

  it("pattern search climbs to the peak", () => {
    const r = patternSearch([0.9, 0.1, 0.9], bump, 0.1, 1e-4);
    expect(r.x[0]).toBeCloseTo(0.3, 3);
    expect(r.x[2]).toBeCloseTo(0.5, 3);
  });

  it("never does worse than a seed design", () => {
    const params = [
      { key: "platformHalfAngleDeg" as const, min: 10, max: 50 },
      { key: "servoTiltDeg" as const, min: -10, max: 30 },
    ];
    const seed = { ...geo, platformHalfAngleDeg: 20, servoTiltDeg: 15 };
    const seeded = optimizeDesign(geo, params, lim, C, goal, { population: 6, generations: 1, seed: 4, keep: 1, seeds: [seed] });
    expect(seeded[0]!.score).toBeGreaterThanOrEqual(evaluateDesign(seed, lim, C, goal).score);
  });

  it("encodes and decodes a geometry", () => {
    const params = [{ key: "rodLength" as const, min: 100, max: 160 }, { key: "servoTiltDeg" as const, min: -20, max: 40 }];
    const g = { ...geo, rodLength: 130, servoTiltDeg: 10 };
    expect(decode(geo, params, encode(g, params))).toEqual(g);
  });

  it("snaps discrete parameters to allowed values", () => {
    const g = decode(geo, [{ key: "hornLength", min: 10, max: 30, values: [14, 18, 22] }], [0.62]);
    expect(g.hornLength).toBe(22);
  });

  it("returns distinct designs at least as good as the starting layout", () => {
    const params = [
      { key: "platformHalfAngleDeg" as const, min: 10, max: 50 },
      { key: "servoTiltDeg" as const, min: -10, max: 30 },
    ];
    const designs = optimizeDesign(geo, params, lim, C, goal, { population: 12, generations: 6, seed: 1, keep: 3 });
    expect(designs.length).toBeGreaterThan(0);
    expect(designs[0]!.score).toBeGreaterThanOrEqual(evaluateDesign(geo, lim, C, goal).score);
    for (let i = 1; i < designs.length; i++) expect(designs[i]!.score).toBeLessThanOrEqual(designs[i - 1]!.score);
  });
});
