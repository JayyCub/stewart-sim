import { buildLayout, solve } from "./ik.ts";
import { legTorques } from "./statics.ts";
import { REACH_REF } from "./sweep.ts";
import { AXES, workspace, type Axis, type Reach } from "./workspace.ts";
import type { Collision, Geometry, Limits, Pose } from "./types.ts";

/**
 * Whole-design optimisation: differential evolution over every free geometry
 * and mount parameter at once, then a pattern-search polish of the best few
 * distinct designs. Deterministic for a given seed.
 */

/** One free parameter. `values`, if given, are the only allowed settings (e.g. the horn's holes); the search snaps to the nearest. */
export interface FreeParam {
  key: keyof Geometry;
  min: number;
  max: number;
  values?: number[];
}

export interface DesignGoal {
  /** Relative importance of each axis's span; 0 ignores an axis. */
  weights: Record<Axis, number>;
  /** Mass carried by the platform (top plate included), kg, acting at its centre. */
  payloadKg: number;
  /** Largest static torque a servo may be asked to hold, N·mm (rated torque × safety factor). */
  torqueLimitNmm: number;
}

export interface Design {
  geometry: Geometry;
  /** Weighted reach score with the torque penalty applied; 0 for an unusable design. */
  score: number;
  /** Weighted reach score before the torque penalty. */
  reachScore: number;
  reach: Record<Axis, Reach>;
  /** Largest servo torque over the check poses, N·mm (Infinity if some pose is singular). */
  maxTorqueNmm: number;
  homeHeight: number;
}

/** Weighted geometric mean of each axis span over its reference span. Zero if a weighted axis cannot move. */
export function weightedReachScore(reach: Record<Axis, Reach>, weights: Record<Axis, number>): number {
  let sum = 0, wsum = 0;
  for (const ax of AXES) {
    const w = weights[ax];
    if (!(w > 0)) continue;
    const span = reach[ax].max - reach[ax].min;
    if (!(span > 0)) return 0;
    sum += w * Math.log(span / REACH_REF[ax]);
    wsum += w;
  }
  return wsum > 0 ? Math.exp(sum / wsum) : 0;
}

const ZERO: Pose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };

/**
 * Evaluate one design: collision-aware single-axis reach, then servo torque
 * at home and at 80% of each axis's reach in both directions. Designs that
 * need more torque than the limit are penalised steeply (score × (limit/τ)⁴)
 * rather than cut off, which keeps the search landscape smooth.
 */
export function evaluateDesign(g: Geometry, lim: Limits, col: Collision, goal: DesignGoal): Design {
  const layout = buildLayout(g);
  const reach = workspace(layout, g, lim, col);
  const reachScore = weightedReachScore(reach, goal.weights);
  const fail = { geometry: g, score: 0, reachScore, reach, maxTorqueNmm: Infinity, homeHeight: layout.homeHeight };
  if (reachScore === 0) return fail;

  let maxTorque = 0;
  const poses: Pose[] = [ZERO];
  for (const ax of AXES) poses.push({ ...ZERO, [ax]: 0.8 * reach[ax].min }, { ...ZERO, [ax]: 0.8 * reach[ax].max });
  for (const p of poses) {
    const t = legTorques(layout, solve(layout, g, lim, p, col), p, goal.payloadKg);
    if (!t) return fail;
    for (const v of t) maxTorque = Math.max(maxTorque, Math.abs(v));
  }
  const penalty = Math.min(1, goal.torqueLimitNmm / maxTorque) ** 4;
  return { geometry: g, score: reachScore * penalty, reachScore, reach, maxTorqueNmm: maxTorque, homeHeight: layout.homeHeight };
}

/** Small deterministic PRNG (LCG), so runs are repeatable. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export interface DEOptions {
  population: number;
  generations: number;
  seed: number;
  /** Differential weight. */
  F?: number;
  /** Crossover rate. */
  CR?: number;
  /** Starting points to put in the population in place of random ones (unit-cube coordinates). */
  initial?: number[][];
  /** Called for every evaluation; used to keep an archive of candidates. */
  onEval?: (x: number[], score: number) => void;
  onGeneration?: (gen: number, best: number) => void;
}

/**
 * Maximise f over the unit cube [0, 1]^dims with differential evolution
 * (rand/1/bin). Out-of-range trial values are reflected back inside.
 */
export function differentialEvolution(dims: number, f: (x: number[]) => number, o: DEOptions): { x: number[]; score: number } {
  const rand = rng(o.seed);
  const F = o.F ?? 0.6, CR = o.CR ?? 0.9;
  const evalx = (x: number[]) => {
    const s = f(x);
    o.onEval?.(x, s);
    return s;
  };
  const pop = Array.from({ length: o.population }, (_, i) => o.initial?.[i]?.slice() ?? Array.from({ length: dims }, rand));
  const fit = pop.map(evalx);
  for (let gen = 0; gen < o.generations; gen++) {
    for (let i = 0; i < pop.length; i++) {
      let a: number, b: number, c: number;
      do a = Math.floor(rand() * pop.length); while (a === i);
      do b = Math.floor(rand() * pop.length); while (b === i || b === a);
      do c = Math.floor(rand() * pop.length); while (c === i || c === a || c === b);
      const jr = Math.floor(rand() * dims);
      const trial = pop[i]!.map((v, j) => {
        if (j !== jr && rand() > CR) return v;
        let t = pop[a]![j]! + F * (pop[b]![j]! - pop[c]![j]!);
        if (t < 0) t = -t;
        if (t > 1) t = 2 - t;
        return Math.min(1, Math.max(0, t));
      });
      const s = evalx(trial);
      if (s >= fit[i]!) {
        pop[i] = trial;
        fit[i] = s;
      }
    }
    o.onGeneration?.(gen, Math.max(...fit));
  }
  const best = fit.indexOf(Math.max(...fit));
  return { x: pop[best]!, score: fit[best]! };
}

/** Maximise f from x by compass search in the unit cube: try ± step on each coordinate, halve the step when nothing improves. */
export function patternSearch(x0: number[], f: (x: number[]) => number, step = 0.05, minStep = 0.002): { x: number[]; score: number } {
  let x = [...x0], best = f(x);
  while (step >= minStep) {
    let improved = false;
    for (let j = 0; j < x.length; j++) {
      for (const dir of [1, -1]) {
        const t = [...x];
        t[j] = Math.min(1, Math.max(0, t[j]! + dir * step));
        if (t[j] === x[j]) continue;
        const s = f(t);
        if (s > best) {
          x = t;
          best = s;
          improved = true;
          break;
        }
      }
    }
    if (!improved) step /= 2;
  }
  return { x, score: best };
}

/** Map a geometry to the unit cube (inverse of decode, clamped to the parameter ranges). */
export function encode(g: Geometry, params: FreeParam[]): number[] {
  return params.map((p) => (p.max > p.min ? Math.min(1, Math.max(0, ((g[p.key] ?? 0) - p.min) / (p.max - p.min))) : 0));
}

/** Map a point of the unit cube to a geometry, snapping discrete parameters. */
export function decode(base: Geometry, params: FreeParam[], x: number[]): Geometry {
  const g = { ...base };
  params.forEach((p, j) => {
    let v = p.min + (p.max - p.min) * x[j]!;
    if (p.values?.length) v = p.values.reduce((best, c) => (Math.abs(c - v) < Math.abs(best - v) ? c : best));
    g[p.key] = Math.round(v * 10) / 10; // 0.1 mm / 0.1°: finer than anyone can build
  });
  return g;
}

export interface OptimizeOptions extends Omit<DEOptions, "onEval" | "initial"> {
  /** Designs to start from (e.g. the winners of a more constrained search), so the result is never worse than them. */
  seeds?: Geometry[];
  /** How many distinct designs to return. */
  keep: number;
  /** Minimum RMS distance (in unit-cube terms) between returned designs. */
  minDistance?: number;
}

/**
 * Search the free parameters for the best designs. Returns up to `keep`
 * designs, best first, each polished locally and at least `minDistance`
 * apart, so the list shows real alternatives rather than near-copies.
 */
export function optimizeDesign(
  base: Geometry,
  params: FreeParam[],
  lim: Limits,
  col: Collision,
  goal: DesignGoal,
  o: OptimizeOptions,
): Design[] {
  const cache = new Map<string, Design>();
  const evaluate = (x: number[]) => {
    const g = decode(base, params, x);
    const key = params.map((p) => g[p.key]).join(",");
    let d = cache.get(key);
    if (!d) cache.set(key, (d = evaluateDesign(g, lim, col, goal)));
    return d;
  };
  const archive: { x: number[]; score: number }[] = [];
  const initial = (o.seeds ?? []).map((g) => encode(g, params));
  differentialEvolution(params.length, (x) => evaluate(x).score, { ...o, initial, onEval: (x, score) => score > 0 && archive.push({ x, score }) });

  archive.sort((a, b) => b.score - a.score);
  const minD = o.minDistance ?? 0.15;
  const dist = (a: number[], b: number[]) => Math.sqrt(a.reduce((s, v, j) => s + (v - b[j]!) ** 2, 0) / a.length);
  const picked: number[][] = [];
  for (const c of archive) {
    if (picked.length >= o.keep) break;
    if (picked.every((p) => dist(p, c.x) >= minD)) picked.push(c.x);
  }
  return picked
    .map((x) => evaluate(patternSearch(x, (y) => evaluate(y).score).x))
    .sort((a, b) => b.score - a.score);
}
