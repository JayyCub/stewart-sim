import { describe, expect, it } from "vitest";
import { DEG, buildLayout, rodLengthOf, solve, workspace, type Geometry, type Limits, type Pose } from "../src/index.ts";

const geo: Geometry = {
  baseRadius: 85, platformRadius: 60, baseHalfAngleDeg: 15, platformHalfAngleDeg: 30, hornLength: 22, rodLength: 120,
};
const lim: Limits = { servoMinDeg: -70, servoMaxDeg: 70, ballSwivelDeg: 30 };
const layout = buildLayout(geo);
const pose = (p: Partial<Pose> = {}): Pose => ({ x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0, ...p });
const alphas = (p: Partial<Pose>) => solve(layout, geo, lim, pose(p)).legs.map((l) => l.alpha);

/** Small deterministic PRNG so the tests never flake. */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("layout", () => {
  it("has a real home height for a buildable geometry", () => {
    expect(layout.homeHeight).toBeGreaterThan(0);
    expect(layout.homeHeight).toBeLessThan(geo.rodLength);
  });

  it("marks a geometry whose rods cannot reach as unbuildable", () => {
    const short = { ...geo, rodLength: 10 };
    const l = buildLayout(short);
    expect(l.homeHeight).toBeNaN();
    expect(solve(l, short, lim, pose()).ok).toBe(false);
  });
});

describe("solve", () => {
  it("puts every horn level at home", () => {
    const sol = solve(layout, geo, lim, pose());
    expect(sol.ok).toBe(true);
    for (const leg of sol.legs) expect(leg.alpha).toBeCloseTo(0, 12);
  });

  it("returns angles that satisfy the rod and horn lengths exactly", () => {
    const r = rng(42);
    let checked = 0;
    for (let k = 0; k < 500; k++) {
      const p = pose({
        x: (r() - 0.5) * 40, y: (r() - 0.5) * 40, z: (r() - 0.5) * 30,
        roll: (r() - 0.5) * 30 * DEG, pitch: (r() - 0.5) * 30 * DEG, yaw: (r() - 0.5) * 40 * DEG,
      });
      for (const leg of solve(layout, geo, lim, p).legs) {
        if (leg.faults.includes("no-solution")) continue;
        expect(rodLengthOf(leg)).toBeCloseTo(geo.rodLength, 9);
        const dx = leg.hornTip[0] - leg.pivot[0], dy = leg.hornTip[1] - leg.pivot[1], dz = leg.hornTip[2] - leg.pivot[2];
        expect(Math.hypot(dx, dy, dz)).toBeCloseTo(geo.hornLength, 9);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(2000);
  });

  it("raises all horns equally for pure heave up, and lowers them for heave down", () => {
    const up = alphas({ z: 10 });
    const down = alphas({ z: -10 });
    for (const a of up) expect(a).toBeCloseTo(up[0]!, 12);
    expect(up[0]).toBeGreaterThan(0);
    expect(down[0]).toBeLessThan(0);
  });

  it("is three-fold symmetric: rotating a translation by 120 degrees shifts legs by two", () => {
    const x = 12, y = -7, c = Math.cos((2 * Math.PI) / 3), s = Math.sin((2 * Math.PI) / 3);
    const a = alphas({ x, y, z: 4, yaw: 5 * DEG });
    const b = alphas({ x: c * x - s * y, y: s * x + c * y, z: 4, yaw: 5 * DEG });
    for (let i = 0; i < 6; i++) expect(b[(i + 2) % 6]).toBeCloseTo(a[i]!, 10);
  });

  it("is mirror symmetric across the xz plane", () => {
    const a = alphas({ x: 8, y: 11, roll: 6 * DEG, pitch: -4 * DEG, yaw: 7 * DEG });
    const b = alphas({ x: 8, y: -11, roll: -6 * DEG, pitch: -4 * DEG, yaw: -7 * DEG });
    const mirror = [1, 0, 5, 4, 3, 2];
    for (let i = 0; i < 6; i++) expect(b[mirror[i]!]).toBeCloseTo(a[i]!, 10);
  });

  it("reports no-solution when the platform is out of reach", () => {
    const sol = solve(layout, geo, lim, pose({ z: 200 }));
    expect(sol.ok).toBe(false);
    for (const leg of sol.legs) {
      expect(leg.faults).toContain("no-solution");
      expect(leg.alpha).toBeNaN();
    }
  });

  it("reports servo-range when a reachable pose needs more travel than allowed", () => {
    const tight: Limits = { ...lim, servoMaxDeg: 5 };
    const sol = solve(layout, geo, tight, pose({ z: 10 }));
    expect(sol.ok).toBe(false);
    expect(sol.legs[0]!.faults).toEqual(["servo-range"]);
  });

  it("reports ball swivel when the joints are over-tilted", () => {
    const stiff: Limits = { ...lim, ballSwivelDeg: 1 };
    const sol = solve(layout, geo, stiff, pose());
    expect(sol.legs.some((l) => l.faults.includes("ball-swivel-bottom") || l.faults.includes("ball-swivel-top"))).toBe(true);
  });
});

describe("workspace", () => {
  const ws = workspace(layout, geo, lim);

  it("finds motion on every axis for a buildable geometry", () => {
    for (const r of Object.values(ws)) {
      expect(r.max).toBeGreaterThan(0);
      expect(r.min).toBeLessThan(0);
    }
  });

  it("is symmetric in sway and roll, matching the mirror symmetry", () => {
    expect(-ws.y.min).toBeCloseTo(ws.y.max, 6);
    expect(-ws.roll.min).toBeCloseTo(ws.roll.max, 6);
  });

  it("stops each axis just before a limit is broken", () => {
    const over = solve(layout, geo, lim, pose({ z: ws.z.max + 0.01 }));
    const under = solve(layout, geo, lim, pose({ z: ws.z.max - 0.01 }));
    expect(under.ok).toBe(true);
    expect(over.ok).toBe(false);
  });
});
