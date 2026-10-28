import { DEG } from "./math.ts";
import { buildLayout } from "./ik.ts";
import { AXES, workspace, type Axis, type Reach } from "./workspace.ts";
import type { Collision, Geometry, Limits } from "./types.ts";

/** One geometry parameter to vary: `steps` evenly spaced values from min to max inclusive. */
export interface SweepRange {
  key: keyof Geometry;
  min: number;
  max: number;
  steps: number;
}

export interface SweepResult {
  geometry: Geometry;
  /** Geometric mean of each axis span over its reference span; 0 if any axis cannot move. */
  score: number;
  reach: Record<Axis, Reach>;
  homeHeight: number;
}

/**
 * Reference span per axis (max - min) used to normalise scores, so millimetres
 * and radians weigh the same. A score of 1 means every axis spans its reference.
 */
export const REACH_REF: Record<Axis, number> = { x: 60, y: 60, z: 40, roll: 30 * DEG, pitch: 30 * DEG, yaw: 60 * DEG };

const values = (r: SweepRange) =>
  r.steps <= 1 ? [r.min] : Array.from({ length: r.steps }, (_, i) => r.min + ((r.max - r.min) * i) / (r.steps - 1));

/** Number of geometries a sweep will try. */
export const sweepSize = (ranges: SweepRange[]) => ranges.reduce((n, r) => n * Math.max(1, r.steps), 1);

/** Every combination of the swept values, with unswept parameters taken from `base`. */
export function* sweepCandidates(base: Geometry, ranges: SweepRange[]): Generator<Geometry> {
  const lists = ranges.map(values);
  const idx = ranges.map(() => 0);
  const total = sweepSize(ranges);
  for (let n = 0; n < total; n++) {
    const g = { ...base };
    ranges.forEach((r, k) => (g[r.key] = lists[k]![idx[k]!]!));
    yield g;
    for (let k = idx.length - 1; k >= 0; k--) {
      if (++idx[k]! < lists[k]!.length) break;
      idx[k] = 0;
    }
  }
}

/**
 * Score one geometry by its single-axis workspace. The geometric mean rewards
 * balanced layouts: an axis with no motion zeroes the score.
 */
export function scoreGeometry(g: Geometry, lim: Limits, col?: Collision): SweepResult {
  const layout = buildLayout(g);
  const reach = workspace(layout, g, lim, col);
  let logSum = 0;
  for (const ax of AXES) {
    const span = reach[ax].max - reach[ax].min;
    if (!(span > 0)) return { geometry: g, score: 0, reach, homeHeight: layout.homeHeight };
    logSum += Math.log(span / REACH_REF[ax]);
  }
  return { geometry: g, score: Math.exp(logSum / AXES.length), reach, homeHeight: layout.homeHeight };
}

/** Keeps the best `size` results, highest score first. */
export class TopK {
  readonly items: SweepResult[] = [];
  private readonly size: number;
  // Plain field, not a parameter property: scripts/ load this file with Node's type stripping.
  constructor(size: number) {
    this.size = size;
  }
  add(r: SweepResult) {
    if (r.score <= 0) return;
    if (this.items.length === this.size && r.score <= this.items[this.items.length - 1]!.score) return;
    const at = this.items.findIndex((it) => r.score > it.score);
    this.items.splice(at < 0 ? this.items.length : at, 0, r);
    if (this.items.length > this.size) this.items.pop();
  }
}

/** Run a whole sweep synchronously. The app runs the same loop in a worker. */
export function sweep(base: Geometry, ranges: SweepRange[], lim: Limits, col?: Collision, keep = 20): SweepResult[] {
  const top = new TopK(keep);
  for (const g of sweepCandidates(base, ranges)) top.add(scoreGeometry(g, lim, col));
  return top.items;
}
