import { describe, expect, it } from "vitest";
import {
  G0, LIGHT_AIRCRAFT as ac, LON, derivative, eigenvalues, eulerFromQuat, linearize, modes, step, submatrix, trimLevel, type State,
} from "../src/index.ts";

const trim = trimLevel(ac, 55, 1000);
const lin = linearize(ac, trim);
const m = Object.fromEntries(modes(lin).map((x) => [x.name, x]));

/** Longitudinal perturbation [u, w, q, θ] of a non-linear state from trim. */
function lonDev(s: State): number[] {
  return [s.vel[0] - trim.state.vel[0], s.vel[2] - trim.state.vel[2], s.w[1], eulerFromQuat(s.q)[1] - trim.alpha];
}

describe("eigenvalue solver", () => {
  it("finds a known damped oscillator", () => {
    const e = eigenvalues([[0, 1], [-4, -0.4]]).filter((z) => z.im > 0)[0]!;
    expect(e.re).toBeCloseTo(-0.2, 10);
    expect(e.im).toBeCloseTo(Math.sqrt(4 - 0.04), 10);
  });

  it("finds the eigenvalues of a 4×4 with known spectrum (similarity transform of a block diagonal)", () => {
    // Blocks: complex pair −1 ± 2i, reals −3 and 0.5; mixed by an invertible T.
    const D = [[-1, 2, 0, 0], [-2, -1, 0, 0], [0, 0, -3, 0], [0, 0, 0, 0.5]];
    const T = [[1, 2, 0, 1], [0, 1, 1, 0], [1, 0, 1, 1], [0, 1, 0, 2]];
    const Ti = invert(T);
    const A = mul(mul(T, D), Ti);
    const e = eigenvalues(A).sort((a, b) => a.re - b.re || a.im - b.im);
    expect(e[0]!.re).toBeCloseTo(-3, 8);
    expect(e[1]!.re).toBeCloseTo(-1, 8);
    expect(Math.abs(e[1]!.im)).toBeCloseTo(2, 8);
    expect(e[3]!.re).toBeCloseTo(0.5, 8);
  });
});

describe("trim", () => {
  it("is an equilibrium: every acceleration is zero", () => {
    const d = derivative(ac, trim.state, trim.controls).d;
    for (const v of [...d.vel, ...d.w]) expect(Math.abs(v)).toBeLessThan(1e-8);
    expect(Math.abs(d.pos[2])).toBeLessThan(1e-8); // level: no climb
  });

  it("holds for a minute in the non-linear simulation with controls frozen", () => {
    let s = trim.state;
    for (let i = 0; i < 6000; i++) s = step(ac, s, trim.controls, 0.01);
    expect(Math.abs(-s.pos[2] - 1000)).toBeLessThan(0.05);
    expect(Math.abs(Math.hypot(...s.vel) - 55)).toBeLessThan(0.01);
  });

  it("needs more angle of attack and elevator at lower speed (the usual trim curve)", () => {
    const slow = trimLevel(ac, 40, 1000);
    expect(slow.alpha).toBeGreaterThan(trim.alpha);
    expect(slow.controls.de).toBeGreaterThan(trim.controls.de);
  });

  it("refuses speeds the engine cannot hold", () => {
    expect(() => trimLevel(ac, 80, 1000)).toThrow(/throttle/);
  });
});

describe("linear model vs non-linear simulation", () => {
  it("predicts a small perturbation's response over 10 s", () => {
    const A = submatrix(lin.A, LON);
    const x0 = [0, 1, 0, 0]; // 1 m/s vertical gust-like kick
    let s: State = { ...trim.state, vel: [trim.state.vel[0], trim.state.vel[1], trim.state.vel[2] + 1] };
    let x = [...x0];
    const dt = 0.01;
    let worst = 0;
    for (let i = 0; i < 1000; i++) {
      s = step(ac, s, trim.controls, dt);
      x = rk4(A, x, dt);
      const d = lonDev(s);
      worst = Math.max(worst, ...d.map((v, k) => Math.abs(v - x[k]!) / [1, 1, 0.1, 0.02][k]!));
    }
    // Errors are second order in the kick size: under 3 % of the scale of each state.
    expect(worst).toBeLessThan(0.03);
  });

  it("phugoid period in the non-linear sim matches the linear prediction (and is near Lanchester's estimate)", () => {
    let s: State = { ...trim.state, vel: [trim.state.vel[0] + 2, trim.state.vel[1], trim.state.vel[2]] };
    const crossings: number[] = [];
    let prev = 2;
    for (let i = 1; i <= 20000; i++) {
      s = step(ac, s, trim.controls, 0.01);
      const du = s.vel[0] - trim.state.vel[0];
      if (prev > 0 && du <= 0) crossings.push(i * 0.01);
      prev = du;
    }
    const periods = crossings.slice(1).map((t, i) => t - crossings[i]!);
    const measured = periods.reduce((a, b) => a + b, 0) / periods.length;
    expect(measured / m["Phugoid"]!.period!).toBeCloseTo(1, 1); // within 5 %
    const lanchester = (Math.PI * Math.SQRT2 * 55) / G0;
    expect(Math.abs(measured / lanchester - 1)).toBeLessThan(0.3);
  });

  it("has the five conventional modes, with the stable ones a light aircraft should have", () => {
    expect(m["Short period"]!.zeta!).toBeGreaterThan(0.3);
    expect(m["Short period"]!.period!).toBeLessThan(3);
    expect(m["Phugoid"]!.zeta!).toBeGreaterThan(0);
    expect(m["Phugoid"]!.period!).toBeGreaterThan(15);
    expect(m["Dutch roll"]!.zeta!).toBeGreaterThan(0);
    expect(m["Roll subsidence"]!.tau!).toBeGreaterThan(0);
    expect(m["Roll subsidence"]!.tau!).toBeLessThan(1);
  });
});

function rk4(A: number[][], x: number[], h: number): number[] {
  const f = (v: number[]) => A.map((row) => row.reduce((s, a, j) => s + a * v[j]!, 0));
  const k1 = f(x);
  const k2 = f(x.map((v, i) => v + (h / 2) * k1[i]!));
  const k3 = f(x.map((v, i) => v + (h / 2) * k2[i]!));
  const k4 = f(x.map((v, i) => v + h * k3[i]!));
  return x.map((v, i) => v + (h / 6) * (k1[i]! + 2 * k2[i]! + 2 * k3[i]! + k4[i]!));
}

function mul(X: number[][], Y: number[][]): number[][] {
  return X.map((row) => Y[0]!.map((_, j) => row.reduce((s, v, k) => s + v * Y[k]![j]!, 0)));
}

function invert(M: number[][]): number[][] {
  const n = M.length;
  const A = M.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[p]![c]!)) p = r;
    [A[c], A[p]] = [A[p]!, A[c]!];
    const d = A[c]![c]!;
    A[c] = A[c]!.map((v) => v / d);
    for (let r = 0; r < n; r++) if (r !== c) {
      const f = A[r]![c]!;
      A[r] = A[r]!.map((v, k) => v - f * A[c]![k]!);
    }
  }
  return A.map((r) => r.slice(n));
}
