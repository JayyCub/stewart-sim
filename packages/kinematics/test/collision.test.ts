import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLLISION as C, DEG, TILT_COLLISION, buildLayout, servoClashes, solve, tiltMap, workspace,
  type Geometry, type Limits, type Pose,
} from "../src/index.ts";

const geo: Geometry = {
  baseRadius: 85, platformRadius: 60, baseHalfAngleDeg: 15, platformHalfAngleDeg: 30, hornLength: 22, rodLength: 120,
};
const lim: Limits = { servoMinDeg: -70, servoMaxDeg: 70, ballSwivelDeg: 30 };
/** Limits wide enough that only collisions can fail a pose. */
const open: Limits = { servoMinDeg: -89, servoMaxDeg: 89, ballSwivelDeg: 89 };
const layout = buildLayout(geo);
const pose = (p: Partial<Pose> = {}): Pose => ({ x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0, ...p });
const faultsOf = (p: Partial<Pose>, l = lim, c = C) => new Set(solve(layout, geo, l, pose(p), c).legs.flatMap((leg) => leg.faults));

describe("servo body clashes", () => {
  it("finds none for the default layout", () => {
    expect(servoClashes(layout, C)).toEqual([]);
  });

  it("flags each pair when the servos are squeezed together", () => {
    expect(servoClashes(buildLayout({ ...geo, baseHalfAngleDeg: 12 }), C)).toEqual([[0, 1], [2, 3], [4, 5]]);
  });

  it("respects the minimum clearance", () => {
    expect(servoClashes(layout, { ...C, minClearance: 5 })).toEqual([[0, 1], [2, 3], [4, 5]]);
  });

  it("fails every pose of a clashing layout", () => {
    const squeezed = { ...geo, baseHalfAngleDeg: 12 };
    const sol = solve(buildLayout(squeezed), squeezed, lim, pose(), C);
    expect(sol.ok).toBe(false);
    expect(sol.legs.every((l) => l.faults.includes("servo-clash"))).toBe(true);
  });
});

describe("rod collisions", () => {
  it("passes home", () => {
    expect(solve(layout, geo, lim, pose(), C).ok).toBe(true);
  });

  it("catches a rod running into its servo when the horns swing far down", () => {
    expect(faultsOf({ z: -20 }, open)).toContain("rod-hits-servo");
    expect(faultsOf({ z: -10 }, open)).not.toContain("rod-hits-servo");
  });

  it("catches a rod folded back onto the horn", () => {
    expect(faultsOf({}, lim, { ...C, hornRodMinDeg: 150 })).toContain("rod-hits-horn");
    expect(faultsOf({}, lim, C)).not.toContain("rod-hits-horn");
  });

  it("leaves the plain IK result alone when no collision model is given", () => {
    expect(solve(layout, geo, open, pose({ z: -20 })).ok).toBe(true);
  });
});

describe("collision-aware workspace", () => {
  it("never reaches further than the joint limits alone", () => {
    const plain = workspace(layout, geo, lim), withCol = workspace(layout, geo, lim, C);
    for (const k of Object.keys(plain) as (keyof typeof plain)[]) {
      expect(withCol[k].max).toBeLessThanOrEqual(plain[k].max + 1e-9);
      expect(withCol[k].min).toBeGreaterThanOrEqual(plain[k].min - 1e-9);
    }
    expect(withCol.z.min).toBeGreaterThan(plain.z.min);
  });

  it("shows collisions on the tilt map", () => {
    const m = tiltMap(layout, geo, lim, pose(), 10 * DEG, 11, { ...C, minClearance: 5 });
    expect(m.cells[5 * 11 + 5]).toBe(TILT_COLLISION);
  });
});
