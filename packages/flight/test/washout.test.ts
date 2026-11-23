import { describe, expect, it } from "vitest";
import { CueMeter, DEFAULT_WASHOUT, G0, TransferFunction, Turbulence, Washout, makeRng, type V3 } from "../src/index.ts";

const DT = 0.01;
const DEG = Math.PI / 180;
const LEVEL: V3 = [0, 0, -G0]; // straight and level: 1 g, body z down
const run = (w: Washout, f: V3, rate: V3, seconds: number) => {
  const out = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) out.push(w.step(f, rate, DT));
  return out;
};

describe("TransferFunction", () => {
  it("unity low-pass settles to the input; high-pass settles to zero", () => {
    const lp = new TransferFunction([4], [1, 4, 4]);
    const hp = new TransferFunction([1, 0, 0], [1, 4, 4]);
    let y1 = 0, y2 = 0;
    for (let i = 0; i < 1000; i++) {
      y1 = lp.step(1, DT);
      y2 = hp.step(1, DT);
    }
    expect(y1).toBeCloseTo(1, 6);
    expect(y2).toBeCloseTo(0, 6);
  });

  it("matches a closed-form first-order step response", () => {
    const f = new TransferFunction([2], [1, 2]); // 2/(s+2): y = 1 − e^(−2t)
    let y = 0;
    for (let i = 0; i < 50; i++) y = f.step(1, DT);
    expect(y).toBeCloseTo(1 - Math.exp(-1), 8);
  });
});

describe("classical washout", () => {
  it("level flight is the neutral pose", () => {
    const p = run(new Washout(), LEVEL, [0, 0, 0], 5).at(-1)!;
    for (const v of Object.values(p)) expect(Math.abs(v)).toBeLessThan(1e-9);
  });

  it("a sustained forward push: platform surges forward, then returns to centre while tilting back", () => {
    const w = new Washout();
    const poses = run(w, [2, 0, -G0], [0, 0, 0], 20);
    expect(Math.max(...poses.map((p) => p.x))).toBeGreaterThan(5); // onset is felt as real motion (mm)
    const end = poses.at(-1)!;
    expect(Math.abs(end.x)).toBeLessThan(0.1); // washed out
    // Tilt coordination: gravity along the rider's x matches the scaled push.
    expect(end.pitch).toBeCloseTo(-Math.asin((DEFAULT_WASHOUT.tiltGain * 2) / G0), 4);
  });

  it("never tilts faster than the rate limit, nor further than tiltMax", () => {
    const w = new Washout();
    const poses = run(w, [9, -9, -G0], [0, 0, 0], 20);
    for (let i = 1; i < poses.length; i++) {
      expect(Math.abs(poses[i]!.pitch - poses[i - 1]!.pitch)).toBeLessThanOrEqual(DEFAULT_WASHOUT.tiltRateMax * DT + 1e-12);
    }
    expect(Math.abs(poses.at(-1)!.pitch)).toBeCloseTo(DEFAULT_WASHOUT.tiltMax, 6);
    expect(Math.abs(poses.at(-1)!.roll)).toBeCloseTo(DEFAULT_WASHOUT.tiltMax, 6);
  });

  it("a steady roll rate gives a roll onset cue that washes back to zero", () => {
    const poses = run(new Washout(), LEVEL, [10 * DEG, 0, 0], 15);
    expect(Math.max(...poses.map((p) => p.roll))).toBeGreaterThan(1 * DEG);
    expect(Math.abs(poses.at(-1)!.roll)).toBeLessThan(0.01 * DEG);
  });

  it("maps aircraft axes to rig axes: nose-up pitch rate pitches the rig nose up (negative rig pitch)", () => {
    const p = run(new Washout(), LEVEL, [0, 5 * DEG, 0], 0.5).at(-1)!;
    expect(p.pitch).toBeLessThan(0);
  });

  it("extra g (pull-up) heaves the platform up first", () => {
    const p = run(new Washout(), [0, 0, -1.5 * G0], [0, 0, 0], 0.3).at(-1)!;
    expect(p.z).toBeGreaterThan(0);
  });
});

describe("CueMeter (what the rider on the platform feels)", () => {
  it("a platform pitched back holds the rider's x specific force at g·sin(tilt)", () => {
    const m = new CueMeter();
    const pose = { x: 0, y: 0, z: 0, roll: 0, pitch: -5 * DEG, yaw: 0 };
    for (let i = 0; i < 3; i++) m.push(pose, DT);
    expect(m.f[0]).toBeCloseTo(G0 * Math.sin(5 * DEG), 9);
  });

  it("a platform accelerating forward reads that acceleration", () => {
    const m = new CueMeter();
    // x = ½·a·t² in mm with a = 1 m/s²
    for (let i = 0; i < 3; i++) m.push({ x: 500 * (i * DT) ** 2, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 }, DT);
    expect(m.f[0]).toBeCloseTo(1, 6);
    expect(m.f[2]).toBeCloseTo(G0, 9);
  });
});

describe("turbulence", () => {
  it("each gust component has the requested standard deviation", () => {
    const t = new Turbulence(2, 7);
    const n = 200000;
    const sums = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const g = t.step(55, 0.05);
      for (let k = 0; k < 3; k++) sums[k]! += g[k]! ** 2;
    }
    for (const s of sums) expect(Math.abs(Math.sqrt(s / n) - 2)).toBeLessThan(0.15);
  });

  it("is repeatable for a given seed", () => {
    const a = new Turbulence(2, 3), b = new Turbulence(2, 3);
    for (let i = 0; i < 100; i++) expect(a.step(50, DT)).toEqual(b.step(50, DT));
    expect(makeRng(1)()).toBe(makeRng(1)());
  });
});
