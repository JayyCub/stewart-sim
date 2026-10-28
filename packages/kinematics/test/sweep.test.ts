import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLLISION as C, TopK, buildLayout, scoreGeometry, sweep, sweepCandidates, sweepSize, workspace,
  type Geometry, type Limits, type SweepResult,
} from "../src/index.ts";

const geo: Geometry = {
  baseRadius: 85, platformRadius: 60, baseHalfAngleDeg: 15, platformHalfAngleDeg: 30, hornLength: 22, rodLength: 120,
};
const lim: Limits = { servoMinDeg: -70, servoMaxDeg: 70, ballSwivelDeg: 30 };

describe("sweep candidates", () => {
  it("covers every combination once, endpoints included", () => {
    const ranges = [
      { key: "rodLength", min: 100, max: 140, steps: 3 },
      { key: "platformRadius", min: 50, max: 70, steps: 2 },
    ] as const;
    const all = [...sweepCandidates(geo, [...ranges])];
    expect(all).toHaveLength(sweepSize([...ranges]));
    expect(all).toHaveLength(6);
    expect(new Set(all.map((g) => `${g.rodLength},${g.platformRadius}`)).size).toBe(6);
    expect(all.map((g) => g.rodLength).sort((a, b) => a - b)).toEqual([100, 100, 120, 120, 140, 140]);
    expect(all.every((g) => g.baseRadius === geo.baseRadius)).toBe(true);
  });

  it("treats a single step as a fixed value", () => {
    expect([...sweepCandidates(geo, [{ key: "hornLength", min: 18, max: 30, steps: 1 }])].map((g) => g.hornLength)).toEqual([18]);
  });
});

describe("scoring", () => {
  it("scores the default geometry above zero and reports its reach", () => {
    const r = scoreGeometry(geo, lim, C);
    expect(r.score).toBeGreaterThan(0);
    expect(r.reach).toEqual(workspace(buildLayout(geo), geo, lim, C));
  });

  it("scores zero when the servos clash or the rods cannot reach", () => {
    expect(scoreGeometry({ ...geo, baseHalfAngleDeg: 12 }, lim, C).score).toBe(0);
    expect(scoreGeometry({ ...geo, rodLength: 10 }, lim, C).score).toBe(0);
  });
});

describe("sweep", () => {
  const ranges = [
    { key: "platformHalfAngleDeg" as const, min: 10, max: 50, steps: 5 },
    { key: "rodLength" as const, min: 100, max: 160, steps: 4 },
  ];
  const results = sweep(geo, ranges, lim, C, 5);

  it("returns the best results in descending order", () => {
    expect(results.length).toBe(5);
    for (let i = 1; i < results.length; i++) expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
  });

  it("finds the true best candidate", () => {
    const best = Math.max(...[...sweepCandidates(geo, ranges)].map((g) => scoreGeometry(g, lim, C).score));
    expect(results[0]!.score).toBe(best);
  });
});

describe("TopK", () => {
  it("keeps only the highest scores and drops zeros", () => {
    const top = new TopK(3);
    const r = (score: number) => ({ score }) as SweepResult;
    for (const s of [0.2, 0, 0.9, 0.5, 0.1, 0.7]) top.add(r(s));
    expect(top.items.map((i) => i.score)).toEqual([0.9, 0.7, 0.5]);
  });
});
