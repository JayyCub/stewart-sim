/**
 * Trim and linearisation.
 *
 * trimLevel finds the angle of attack, elevator and throttle that hold steady, wings-level,
 * straight and level flight. linearize differentiates the full non-linear model about that
 * point (central differences), and modes() reads the classical dynamic modes off the
 * eigenvalues of the longitudinal and lateral-directional subsystems. Those predictions are
 * what the tests hold the non-linear simulation to.
 */
import type { Aircraft } from "./aircraft.ts";
import { derivative, type Controls, type State } from "./dynamics.ts";
import { eulerFromQuat, quatFromEuler, solveLinear } from "./math.ts";

export interface Trim {
  /** Airspeed (m/s) and altitude (m) the trim is for. */
  V: number;
  alt: number;
  alpha: number;
  controls: Controls;
  state: State;
}

export function levelState(V: number, alt: number, alpha: number, psi = 0): State {
  return {
    pos: [0, 0, -alt],
    vel: [V * Math.cos(alpha), 0, V * Math.sin(alpha)],
    q: quatFromEuler(0, alpha, psi),
    w: [0, 0, 0],
  };
}

/** Steady straight-and-level trim by Newton's method on (u̇, ẇ, q̇) = 0. */
export function trimLevel(ac: Aircraft, V: number, alt: number): Trim {
  let x = [0.03, 0, 0.5]; // alpha, de, throttle
  const resid = (x: number[]) => {
    const u: Controls = { de: x[1]!, da: 0, dr: 0, throttle: x[2]! };
    const d = derivative(ac, levelState(V, alt, x[0]!), u).d;
    return [d.vel[0], d.vel[2], d.w[1]];
  };
  for (let it = 0; it < 50; it++) {
    const r = resid(x);
    if (Math.max(...r.map(Math.abs)) < 1e-10) break;
    const J = [0, 1, 2].map(() => [0, 0, 0]);
    for (let j = 0; j < 3; j++) {
      const h = 1e-6;
      const xp = [...x], xm = [...x];
      xp[j]! += h;
      xm[j]! -= h;
      const rp = resid(xp), rm = resid(xm);
      for (let i = 0; i < 3; i++) J[i]![j] = (rp[i]! - rm[i]!) / (2 * h);
    }
    const dx = solveLinear(J, r.map((v) => -v));
    x = x.map((v, i) => v + dx[i]!);
  }
  const r = resid(x);
  if (Math.max(...r.map(Math.abs)) > 1e-6) throw new Error(`trim did not converge at ${V} m/s`);
  if (x[2]! < 0 || x[2]! > 1) throw new Error(`cannot trim at ${V} m/s: needs throttle ${x[2]!.toFixed(2)}`);
  if (Math.abs(x[1]!) > ac.deMax) throw new Error(`cannot trim at ${V} m/s: elevator out of range`);
  const controls: Controls = { de: x[1]!, da: 0, dr: 0, throttle: x[2]! };
  return { V, alt, alpha: x[0]!, controls, state: levelState(V, alt, x[0]!) };
}

/** Euler-angle state used for linearisation: [u, v, w, p, q, r, φ, θ, ψ, h]. */
export const LIN_STATES = ["u", "v", "w", "p", "q", "r", "phi", "theta", "psi", "h"] as const;
export const LIN_INPUTS = ["de", "da", "dr", "throttle"] as const;

function eulerDerivative(ac: Aircraft, x: number[], u: Controls): number[] {
  const [uu, vv, ww, p, q, r, phi, theta, psi, h] = x as [number, number, number, number, number, number, number, number, number, number];
  const s: State = { pos: [0, 0, -h], vel: [uu, vv, ww], q: quatFromEuler(phi, theta, psi), w: [p, q, r] };
  const d = derivative(ac, s, u).d;
  const tq = Math.tan(theta), cq = Math.cos(theta), sf = Math.sin(phi), cf = Math.cos(phi);
  return [
    d.vel[0], d.vel[1], d.vel[2], d.w[0], d.w[1], d.w[2],
    p + (q * sf + r * cf) * tq,
    q * cf - r * sf,
    (q * sf + r * cf) / cq,
    -d.pos[2],
  ];
}

export interface Linear {
  /** ẋ ≈ A x + B u about the trim, in LIN_STATES / LIN_INPUTS order. */
  A: number[][];
  B: number[][];
}

export function linearize(ac: Aircraft, t: Trim): Linear {
  const [phi, theta, psi] = eulerFromQuat(t.state.q);
  const x0 = [...t.state.vel, ...t.state.w, phi, theta, psi, t.alt];
  const u0 = [t.controls.de, t.controls.da, t.controls.dr, t.controls.throttle];
  const toU = (v: number[]): Controls => ({ de: v[0]!, da: v[1]!, dr: v[2]!, throttle: v[3]! });
  const n = x0.length, m = u0.length;
  const A = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const B = Array.from({ length: n }, () => new Array<number>(m).fill(0));
  for (let j = 0; j < n; j++) {
    const h = 1e-5 * Math.max(1, Math.abs(x0[j]!));
    const xp = [...x0], xm = [...x0];
    xp[j]! += h;
    xm[j]! -= h;
    const fp = eulerDerivative(ac, xp, toU(u0)), fm = eulerDerivative(ac, xm, toU(u0));
    for (let i = 0; i < n; i++) A[i]![j] = (fp[i]! - fm[i]!) / (2 * h);
  }
  for (let j = 0; j < m; j++) {
    const h = 1e-5;
    const up = [...u0], um = [...u0];
    up[j]! += h;
    um[j]! -= h;
    const fp = eulerDerivative(ac, x0, toU(up)), fm = eulerDerivative(ac, x0, toU(um));
    for (let i = 0; i < n; i++) B[i]![j] = (fp[i]! - fm[i]!) / (2 * h);
  }
  return { A, B };
}

/** Rows and columns of A picked out by state index. */
export function submatrix(A: number[][], idx: readonly number[]): number[][] {
  return idx.map((i) => idx.map((j) => A[i]![j]!));
}

export const LON = [0, 2, 4, 7] as const; // u, w, q, θ
export const LAT = [1, 3, 5, 6] as const; // v, p, r, φ

export interface Complex {
  re: number;
  im: number;
}

/** Characteristic polynomial coefficients [1, c1, …, cn] of a square matrix (Faddeev–LeVerrier). */
export function charPoly(A: number[][]): number[] {
  const n = A.length;
  const mul = (X: number[][], Y: number[][]) => X.map((row) => Y[0]!.map((_, j) => row.reduce((s, v, k) => s + v * Y[k]![j]!, 0)));
  const coeffs = [1];
  let M = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let k = 1; k <= n; k++) {
    // M_k = A·M_{k−1} + c_{k−1}·I, c_k = −tr(A·M_k)/k
    const AM = mul(A, M);
    M = AM.map((row, i) => row.map((v, j) => v + (i === j ? coeffs[k - 1]! : 0)));
    const AMk = mul(A, M);
    coeffs.push(-AMk.reduce((s, row, i) => s + row[i]!, 0) / k);
  }
  return coeffs;
}

/** All complex roots of a monic polynomial [1, c1, …, cn] (Durand–Kerner iteration). */
export function polyRoots(c: number[]): Complex[] {
  const n = c.length - 1;
  const cmul = (a: Complex, b: Complex): Complex => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
  const cdiv = (a: Complex, b: Complex): Complex => {
    const d = b.re * b.re + b.im * b.im;
    return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
  };
  const evalAt = (z: Complex): Complex => c.reduce<Complex>((acc, ci) => {
    const m = cmul(acc, z);
    return { re: m.re + ci, im: m.im };
  }, { re: 0, im: 0 });
  // Starting points on a circle large enough to enclose every root.
  const R = 1 + Math.max(...c.slice(1).map(Math.abs));
  let z: Complex[] = Array.from({ length: n }, (_, k) => ({ re: R * Math.cos(0.4 + (2 * Math.PI * k) / n), im: R * Math.sin(0.4 + (2 * Math.PI * k) / n) }));
  for (let it = 0; it < 2000; it++) {
    let moved = 0;
    z = z.map((zi, i) => {
      let den: Complex = { re: 1, im: 0 };
      z.forEach((zj, j) => {
        if (j !== i) den = cmul(den, { re: zi.re - zj.re, im: zi.im - zj.im });
      });
      const dz = cdiv(evalAt(zi), den);
      moved = Math.max(moved, Math.hypot(dz.re, dz.im));
      return { re: zi.re - dz.re, im: zi.im - dz.im };
    });
    if (moved < 1e-13 * R) break;
  }
  return z.map((r) => ({ re: r.re, im: Math.abs(r.im) < 1e-9 ? 0 : r.im }));
}

export const eigenvalues = (A: number[][]): Complex[] => polyRoots(charPoly(A));

export interface Mode {
  name: string;
  eig: Complex;
  /** Oscillatory modes: natural frequency (rad/s), damping ratio and period (s). */
  wn?: number;
  zeta?: number;
  period?: number;
  /** Non-oscillatory modes: time constant (s); negative means the mode diverges. */
  tau?: number;
}

function oscillatory(name: string, e: Complex): Mode {
  const wn = Math.hypot(e.re, e.im);
  return { name, eig: e, wn, zeta: -e.re / wn, period: (2 * Math.PI) / Math.abs(e.im) };
}

/** The five classical modes of a conventional airplane, read off the linear model. */
export function modes(lin: Linear): Mode[] {
  const lon = eigenvalues(submatrix(lin.A, LON)).filter((e) => e.im > 0).sort((a, b) => Math.hypot(b.re, b.im) - Math.hypot(a.re, a.im));
  const latAll = eigenvalues(submatrix(lin.A, LAT));
  const dutch = latAll.find((e) => e.im > 0);
  const real = latAll.filter((e) => e.im === 0).sort((a, b) => Math.abs(b.re) - Math.abs(a.re));
  if (lon.length !== 2 || !dutch || real.length !== 2) throw new Error("unexpected mode structure (not a conventional airplane?)");
  return [
    oscillatory("Short period", lon[0]!),
    oscillatory("Phugoid", lon[1]!),
    oscillatory("Dutch roll", dutch),
    { name: "Roll subsidence", eig: real[0]!, tau: -1 / real[0]!.re },
    { name: "Spiral", eig: real[1]!, tau: -1 / real[1]!.re },
  ];
}
