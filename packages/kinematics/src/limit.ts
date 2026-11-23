import { solve } from "./ik.ts";
import type { Collision, Geometry, Layout, Limits, Pose } from "./types.ts";

export interface LimitedPose {
  pose: Pose;
  /** Fraction of the requested pose kept (1 = untouched, 0 = home). */
  scale: number;
  /** False only if even home fails the checks (unbuildable geometry); pose is then home. */
  ok: boolean;
}

const HOME: Pose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };
const scaled = (p: Pose, k: number): Pose => ({ x: p.x * k, y: p.y * k, z: p.z * k, roll: p.roll * k, pitch: p.pitch * k, yaw: p.yaw * k });

/**
 * Bring a requested pose (e.g. from motion cueing) inside the rig's limits by scaling it toward
 * home, all six axes together so the direction of the cue is kept. Bisects on the scale; the
 * returned pose has always passed the full check (IK, servo range, ball swivel, and collisions
 * when col is given).
 */
export function limitPose(layout: Layout, g: Geometry, lim: Limits, pose: Pose, col?: Collision, iterations = 14): LimitedPose {
  if (solve(layout, g, lim, pose, col).ok) return { pose, scale: 1, ok: true };
  if (!solve(layout, g, lim, HOME, col).ok) return { pose: HOME, scale: 0, ok: false };
  let lo = 0, hi = 1;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    if (solve(layout, g, lim, scaled(pose, mid), col).ok) lo = mid;
    else hi = mid;
  }
  return { pose: scaled(pose, lo), scale: lo, ok: true };
}

/**
 * limitPose with memory, for a stream of poses (motion cueing). The scale may drop at once,
 * which it must to stay valid, but it recovers no faster than recoverPerSec. Without this a cue
 * hovering at the edge of reach makes the scale chatter frame to frame, and the rider feels
 * every jump as a jolt. Every returned pose has passed the full check.
 */
export class PoseLimiter {
  /** Overall fraction of the requested pose kept on the last call. */
  scale = 1;
  recoverPerSec: number;

  constructor(recoverPerSec = 1) {
    this.recoverPerSec = recoverPerSec;
  }

  limit(layout: Layout, g: Geometry, lim: Limits, pose: Pose, dt: number, col?: Collision): LimitedPose {
    const cap = Math.min(1, this.scale + this.recoverPerSec * dt);
    const r = limitPose(layout, g, lim, scaled(pose, cap), col);
    this.scale = cap * r.scale;
    return { pose: r.pose, scale: this.scale, ok: r.ok };
  }

  reset(): void {
    this.scale = 1;
  }
}
