import { DEG } from "./math.ts";
import { solve } from "./ik.ts";
import type { Collision, Geometry, Layout, Limits, Pose } from "./types.ts";

export type Axis = keyof Pose;
export const AXES: readonly Axis[] = ["x", "y", "z", "roll", "pitch", "yaw"];

const ZERO: Pose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };

/** Search caps: translations in mm, rotations in radians. */
const CAP: Record<Axis, number> = { x: 100, y: 100, z: 100, roll: 60 * DEG, pitch: 60 * DEG, yaw: 60 * DEG };

export interface Reach {
  /** Largest reachable value in the negative direction (a negative number, or 0). */
  min: number;
  /** Largest reachable value in the positive direction. */
  max: number;
}

/**
 * Largest single-axis excursion from home that passes every limit check.
 * Assumes reachability is continuous from home along the axis, which holds
 * for normal layouts; the search stops at the first failure it brackets.
 */
export function axisReach(layout: Layout, g: Geometry, lim: Limits, axis: Axis, col?: Collision): Reach {
  if (!solve(layout, g, lim, ZERO, col).ok) return { min: 0, max: 0 };
  const search = (dir: 1 | -1) => {
    const ok = (t: number) => solve(layout, g, lim, { ...ZERO, [axis]: dir * t }, col).ok;
    if (ok(CAP[axis])) return CAP[axis];
    let lo = 0, hi = CAP[axis];
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  return { min: -search(-1), max: search(1) };
}

export function workspace(layout: Layout, g: Geometry, lim: Limits, col?: Collision): Record<Axis, Reach> {
  return Object.fromEntries(AXES.map((ax) => [ax, axisReach(layout, g, lim, ax, col)])) as Record<Axis, Reach>;
}
