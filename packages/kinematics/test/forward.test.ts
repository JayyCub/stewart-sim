import { describe, expect, it } from "vitest";
import { DEG, buildLayout, forward, hornRodAngle, rodBodyGap, solve, type Pose } from "../src/index.ts";
import { defaultRig } from "../../rig-config/src/index.ts";

const { geometry: g, limits: lim, collision: col } = defaultRig;
const layout = buildLayout(g);
const HOME: Pose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };
const alphas = (p: Pose) => solve(layout, g, lim, p).legs.map((l) => l.alpha);

/** Deterministic pseudo-random numbers in [-1, 1). */
function rand(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 31) - 1;
}

describe("forward kinematics", () => {
  it("returns home for level horns", () => {
    const p = forward(layout, g, [0, 0, 0, 0, 0, 0])!;
    for (const k of Object.keys(HOME) as (keyof Pose)[]) expect(Math.abs(p[k])).toBeLessThan(1e-8);
  });

  it("inverts the IK on 200 random valid poses, starting from home", () => {
    const r = rand(7);
    let n = 0;
    while (n < 200) {
      const pose: Pose = { x: 25 * r(), y: 25 * r(), z: 15 * r(), roll: 12 * DEG * r(), pitch: 12 * DEG * r(), yaw: 20 * DEG * r() };
      if (!solve(layout, g, lim, pose, col).ok) continue;
      n++;
      const got = forward(layout, g, alphas(pose));
      expect(got).not.toBeNull();
      expect(got!.x).toBeCloseTo(pose.x, 6);
      expect(got!.z).toBeCloseTo(pose.z, 6);
      expect(got!.yaw).toBeCloseTo(pose.yaw, 8);
    }
  });

  it("follows one horn swinging alone, as on the bench, using each pose as the next guess", () => {
    let guess = HOME;
    for (let d = 0; d <= 40; d += 2) {
      const a = [d * DEG, 0, 0, 0, 0, 0];
      const p = forward(layout, g, a, guess)!;
      expect(p).not.toBeNull();
      alphas(p).forEach((v, i) => expect(v).toBeCloseTo(a[i]!, 8));
      guess = p;
    }
  });

  it("returns null for horn angles no pose can produce", () => {
    expect(forward(layout, g, [170 * DEG, 0, 0, 0, 0, 0])).toBeNull();
  });
});

describe("limit measurements", () => {
  it("hornRodAngle agrees with the rod-hits-horn check", () => {
    const r = rand(3);
    for (let n = 0; n < 300; n++) {
      const pose: Pose = { x: 40 * r(), y: 40 * r(), z: 30 * r(), roll: 20 * DEG * r(), pitch: 20 * DEG * r(), yaw: 30 * DEG * r() };
      const sol = solve(layout, g, lim, pose, col);
      sol.legs.forEach((leg) => {
        if (Number.isNaN(leg.alpha)) return;
        expect(hornRodAngle(leg) < col.hornRodMinDeg * DEG).toBe(leg.faults.includes("rod-hits-horn"));
      });
    }
  });

  it("rodBodyGap <= rodRadius exactly when the rod-hits-servo check fires", () => {
    const r = rand(11);
    let hits = 0;
    for (let n = 0; n < 400; n++) {
      const pose: Pose = { x: 40 * r(), y: 40 * r(), z: 35 * r(), roll: 25 * DEG * r(), pitch: 25 * DEG * r(), yaw: 40 * DEG * r() };
      const sol = solve(layout, g, lim, pose, col);
      sol.legs.forEach((leg) => {
        if (Number.isNaN(leg.alpha)) return;
        const gap = rodBodyGap(layout, col, leg);
        if (Math.abs(gap - col.rodRadius) < 1e-6) return; // on the boundary either answer is fine
        const hit = leg.faults.includes("rod-hits-servo");
        if (hit) hits++;
        expect(gap <= col.rodRadius).toBe(hit);
      });
    }
    expect(hits).toBeGreaterThan(0); // the sample reaches the check, so the comparison means something
  });
});
