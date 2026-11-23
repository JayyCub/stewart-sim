import { solve } from "./ik.ts";
import type { Collision, Geometry, Layout, LegFault, Limits, Pose } from "./types.ts";

/** A pose the hardware has been sent, with its horn angles in degrees (leg order). */
export interface Commanded {
  pose: Pose;
  alphaDeg: number[];
}

export type FollowStep =
  /** Already at the target: send nothing. */
  | { kind: "at-target" }
  /** Next frame: a validated pose on the straight line (in pose space) toward the target. */
  | { kind: "step"; next: Commanded; reached: boolean }
  /** The next pose on the line fails a limit check: hold where we are. */
  | { kind: "blocked"; reason: string; leg?: number; faults?: LegFault[] };

const KEYS = ["x", "y", "z", "roll", "pitch", "yaw"] as const;
const lerp = (a: Pose, b: Pose, f: number): Pose =>
  Object.fromEntries(KEYS.map((k) => [k, a[k] + (b[k] - a[k]) * f])) as unknown as Pose;
const EPS = 1e-9;

/**
 * One frame of "follow the target pose" for live control.
 *
 * Moves along the straight line from the commanded pose to the target, as far as it can
 * without any horn turning more than maxStepDeg (horn speed limit × frame time). Every
 * pose it returns has passed the full check (IK, servo range, ball swivel, and collisions
 * when col is given). If the next pose on the line fails, it returns "blocked" and the
 * caller holds the last frame, so motion stops at most one small step from the limit.
 */
export function followStep(
  layout: Layout,
  g: Geometry,
  lim: Limits,
  from: Commanded,
  target: Pose,
  maxStepDeg: number,
  col?: Collision,
): FollowStep {
  if (KEYS.every((k) => Math.abs(target[k] - from.pose[k]) < EPS)) return { kind: "at-target" };
  if (!(maxStepDeg > 0)) return { kind: "blocked", reason: "horn speed limit is zero" };

  let f = 1;
  for (let i = 0; i < 16; i++) {
    const sol = solve(layout, g, lim, lerp(from.pose, target, f), col);
    const alpha = sol.legs.map((l) => (l.alpha * 180) / Math.PI);
    const step = Math.max(...alpha.map((a, j) => Math.abs(a - from.alphaDeg[j]!)));
    // NaN (no IK solution) fails the speed test too, so it shrinks the step; the final check reports it.
    if (step <= maxStepDeg * 1.001) {
      if (!sol.ok) {
        const leg = sol.legs.findIndex((l) => l.faults.length > 0);
        const faults = sol.legs[leg]!.faults;
        return { kind: "blocked", reason: faults.join(", "), leg, faults };
      }
      return { kind: "step", next: { pose: lerp(from.pose, target, f), alphaDeg: alpha }, reached: f === 1 };
    }
    f *= Number.isFinite(step) ? Math.max(0.05, (maxStepDeg / step) * 0.98) : 0.5;
  }
  // Horn angle is smooth in pose, so this only happens if no small step is valid either.
  return { kind: "blocked", reason: "could not find a step within the horn speed limit" };
}
