import { solve } from "./ik.ts";
import type { Geometry, Layout, Limits, Pose } from "./types.ts";

const KEYS = ["x", "y", "z", "roll", "pitch", "yaw"] as const;
/** Limits wide enough that solve only reports reachability; forward kinematics checks nothing else. */
const OPEN: Limits = { servoMinDeg: -360, servoMaxDeg: 360, ballSwivelDeg: 360 };
const HOME: Pose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };

const toPose = (v: readonly number[]): Pose => Object.fromEntries(KEYS.map((k, i) => [k, v[i]!])) as unknown as Pose;
const maxAbs = (v: readonly number[]) => v.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

/** Solve A x = b (6×6) by Gaussian elimination with partial pivoting; null if singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    if (Math.abs(m[p]![c]!) < 1e-14) return null;
    [m[c], m[p]] = [m[p]!, m[c]!];
    for (let r = c + 1; r < n; r++) {
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r]![n]!;
    for (let k = r + 1; k < n; k++) s -= m[r]![k]! * x[k]!;
    x[r] = s / m[r]![r]!;
  }
  return x;
}

/**
 * Forward kinematics: the platform pose that puts each horn at the given angle (radians, leg
 * order), found by Newton's method on the closed-form IK. A rotary Stewart platform has
 * several assembly modes for the same horn angles; starting from `guess` (default home) finds
 * the one nearest to it, which is the one the built rig is in when guess is a nearby pose it
 * was really at. Returns null if no pose matches (the model says those angles cannot be built).
 */
export function forward(layout: Layout, g: Geometry, alpha: readonly number[], guess: Pose = HOME, tol = 1e-10): Pose | null {
  if (!Number.isFinite(layout.homeHeight) || alpha.length !== 6) return null;
  const resid = (v: readonly number[]) => solve(layout, g, OPEN, toPose(v)).legs.map((l, i) => l.alpha - alpha[i]!);
  let x = KEYS.map((k) => guess[k]);
  let r = resid(x);
  if (r.some((e) => !Number.isFinite(e))) return null;
  const h = 1e-6;
  for (let iter = 0; iter < 60; iter++) {
    const err = maxAbs(r);
    if (err < tol) return toPose(x);
    // Jacobian d(alpha)/d(pose) by central differences: J[i][j] = d alpha_i / d pose_j.
    const J = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
    for (let j = 0; j < 6; j++) {
      const xp = [...x], xm = [...x];
      xp[j]! += h;
      xm[j]! -= h;
      const rp = resid(xp), rm = resid(xm);
      for (let i = 0; i < 6; i++) J[i]![j] = (rp[i]! - rm[i]!) / (2 * h);
    }
    if (J.some((row) => row.some((v) => !Number.isFinite(v)))) return null;
    const dx = solveLinear(J, r.map((e) => -e));
    if (!dx) return null;
    // Backtracking: accept the largest step that reduces the error and stays reachable.
    let accepted = false;
    for (let t = 1; t > 1e-4; t /= 2) {
      const xn = x.map((v, i) => v + t * dx[i]!);
      const rn = resid(xn);
      if (rn.every(Number.isFinite) && maxAbs(rn) < err) {
        x = xn;
        r = rn;
        accepted = true;
        break;
      }
    }
    if (!accepted) return maxAbs(r) < 1e-7 ? toPose(x) : null;
  }
  return maxAbs(r) < 1e-7 ? toPose(x) : null;
}
