import { dot, sub } from "./math.ts";
import type { Layout, Pose, Solution, Vec3 } from "./types.ts";

/** Standard gravity, m/s². */
export const G = 9.80665;

/** Convert N·mm to kg·cm, the unit hobby servo torque is quoted in. */
export const nmmToKgCm = (t: number) => t / G / 10;

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Solve the 6 × 6 system A x = b by Gaussian elimination with partial pivoting. Returns null if A is (near) singular. */
function solve6(A: number[][], b: number[]): number[] | null {
  const n = 6;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-9) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = c + 1; r < n; r++) {
      const k = M[r]![c]! / M[c]![c]!;
      for (let j = c; j <= n; j++) M[r]![j]! -= k * M[c]![j]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let j = r + 1; j < n; j++) s -= M[r]![j]! * x[j]!;
    x[r] = s / M[r]![r]!;
  }
  return x;
}

/**
 * Static servo torques holding a payload still at a solved pose.
 *
 * The payload (kg) acts at the platform centre. Rods are two-force members,
 * so each carries a force along its own axis; the six forces balance the
 * payload's weight and moment. Each servo then holds that rod force on its
 * horn. Returns the load torque on each horn in N·mm, signed about that
 * leg's shaftAxis (use magnitudes; mirrored servos turn the other way), or null when the
 * pose is singular (the rods can't resist some direction of load), which a
 * design should treat as a failure.
 */
export function legTorques(layout: Layout, sol: Solution, pose: Pose, payloadKg: number): number[] | null {
  if (sol.legs.some((l) => Number.isNaN(l.alpha))) return null;
  const T: Vec3 = [pose.x, pose.y, layout.homeHeight + pose.z];
  const dirs = sol.legs.map((l) => {
    const d = sub(l.top, l.hornTip);
    const n = Math.hypot(d[0], d[1], d[2]);
    return [d[0] / n, d[1] / n, d[2] / n] as Vec3;
  });
  // Columns: unit force each rod applies to the platform (compression positive) and its moment about T.
  const A: number[][] = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
  dirs.forEach((d, i) => {
    const m = cross(sub(sol.legs[i]!.top, T), d);
    for (let k = 0; k < 3; k++) {
      A[k]![i] = d[k]!;
      A[k + 3]![i] = m[k]!;
    }
  });
  const weight = payloadKg * G; // N
  const f = solve6(A, [0, 0, weight, 0, 0, 0]);
  if (!f) return null;
  // The rod pushes back on the horn tip with -f d; torque about the shaft axis. N·m -> N·mm via the mm lever arm.
  return sol.legs.map((l, i) => dot(cross(sub(l.hornTip, l.pivot), [-f[i]! * dirs[i]![0], -f[i]! * dirs[i]![1], -f[i]! * dirs[i]![2]]), layout.shaftAxis[i]!));
}
