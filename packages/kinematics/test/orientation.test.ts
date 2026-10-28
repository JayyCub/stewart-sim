import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLLISION as C, DEG, buildLayout, rodLengthOf, servoClashes, solve,
  type Geometry, type Limits, type Pose,
} from "../src/index.ts";
import { dot, norm, sub } from "../src/math.ts";

const geo: Geometry = {
  baseRadius: 85, platformRadius: 60, baseHalfAngleDeg: 15, platformHalfAngleDeg: 30, hornLength: 22, rodLength: 120,
};
const lim: Limits = { servoMinDeg: -89, servoMaxDeg: 89, ballSwivelDeg: 89 };
const pose = (p: Partial<Pose> = {}): Pose => ({ x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0, ...p });

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("servo orientation", () => {
  it("gives exactly the radial layout when yaw and tilt are zero", () => {
    const a = buildLayout(geo), b = buildLayout({ ...geo, servoYawDeg: 0, servoTiltDeg: 0, topStudTiltDeg: 0 });
    expect(b).toEqual(a);
  });

  it("makes a pair's shafts parallel when yaw equals the pair half-spacing", () => {
    const l = buildLayout({ ...geo, servoYawDeg: geo.baseHalfAngleDeg });
    for (let k = 0; k < 3; k++) {
      const a = l.shaftAxis[2 * k]!, b = l.shaftAxis[2 * k + 1]!;
      expect(dot(a, b)).toBeCloseTo(1, 12);
      // ... and pointing along the pair's centre direction.
      expect(Math.atan2(a[1], a[0])).toBeCloseTo(Math.atan2(Math.sin(k * 2 * Math.PI / 3), Math.cos(k * 2 * Math.PI / 3)), 12);
    }
  });

  it("keeps each servo frame orthonormal and the horn level at alpha = 0", () => {
    const l = buildLayout({ ...geo, servoYawDeg: 20, servoTiltDeg: 25, topStudTiltDeg: -15 });
    for (let i = 0; i < 6; i++) {
      const u = l.shaftAxis[i]!, h = l.hornDir[i]!, w = l.hornUp[i]!;
      for (const v of [u, h, w, l.topStudAxis[i]!]) expect(norm(v)).toBeCloseTo(1, 12);
      expect(dot(u, h)).toBeCloseTo(0, 12);
      expect(dot(u, w)).toBeCloseTo(0, 12);
      expect(dot(h, w)).toBeCloseTo(0, 12);
      expect(h[2]).toBe(0);
      expect(w[2]).toBeGreaterThan(0);
    }
    expect(l.shaftAxis[0]![2]).toBeCloseTo(Math.sin(25 * DEG), 12);
  });

  it("solves exactly for turned and tilted servos", () => {
    const g = { ...geo, servoYawDeg: 15, servoTiltDeg: 20, topStudTiltDeg: 10 };
    const l = buildLayout(g);
    const r = rng(11);
    let solved = 0;
    for (let n = 0; n < 300; n++) {
      const p = pose({ x: (r() - 0.5) * 30, y: (r() - 0.5) * 30, z: (r() - 0.5) * 20, roll: (r() - 0.5) * 0.3, pitch: (r() - 0.5) * 0.3, yaw: (r() - 0.5) * 0.6 });
      for (const [i, leg] of solve(l, g, lim, p).legs.entries()) {
        if (Number.isNaN(leg.alpha)) continue;
        solved++;
        expect(rodLengthOf(leg)).toBeCloseTo(g.rodLength, 8);
        const arm = sub(leg.hornTip, leg.pivot);
        expect(norm(arm)).toBeCloseTo(g.hornLength, 8);
        expect(dot(arm, l.shaftAxis[i]!)).toBeCloseTo(0, 8); // the horn swings in the plane normal to its shaft
      }
    }
    expect(solved).toBeGreaterThan(1500);
  });

  it("has every horn level at home when tilted", () => {
    const g = { ...geo, servoYawDeg: 10, servoTiltDeg: 15 };
    for (const leg of solve(buildLayout(g), g, lim, pose()).legs) expect(leg.alpha).toBeCloseTo(0, 9);
  });

  it("lets parallel servos sit much closer together than radial ones", () => {
    const tight = { ...geo, baseHalfAngleDeg: 8 };
    expect(servoClashes(buildLayout(tight), C)).toHaveLength(3);
    expect(servoClashes(buildLayout({ ...tight, servoYawDeg: 8 }), C)).toEqual([]);
  });

  it("catches tilted bodies that only clash in 3D", () => {
    // Tilting the shafts down swings the bodies' lower ends inward, where a pair's V narrows;
    // tilting them up swings the lower ends outward.
    const g = { ...geo, baseHalfAngleDeg: 16 };
    expect(servoClashes(buildLayout(g), C)).toEqual([]);
    expect(servoClashes(buildLayout({ ...g, servoTiltDeg: -30 }), C)).toHaveLength(3);
    expect(servoClashes(buildLayout({ ...g, servoTiltDeg: 30 }), C)).toEqual([]);
  });

  it("can cut the ball-joint swivel used at home", () => {
    const home = (g: Geometry) => {
      const leg = solve(buildLayout(g), g, lim, pose()).legs[0]!;
      return [leg.swivelBottom / DEG, leg.swivelTop / DEG];
    };
    const [b0, t0] = home(geo);
    const best = (key: "servoTiltDeg" | "topStudTiltDeg", idx: 0 | 1) =>
      Math.min(...Array.from({ length: 61 }, (_, k) => home({ ...geo, [key]: k - 30 })[idx]!));
    expect(best("servoTiltDeg", 0)).toBeLessThan(b0! - 5);
    expect(best("topStudTiltDeg", 1)).toBeLessThan(t0! - 5);
  });
});
