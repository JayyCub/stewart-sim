/**
 * Turbulence: gusts along body x, y, z as first-order Gauss–Markov processes, the simplest
 * approximation of the Dryden spectrum (Dryden's lateral and vertical components are really
 * second order). Each component has standard deviation sigma and correlation length L, so
 * its correlation time is L / V. Discretised exactly: g[k+1] = a·g[k] + σ√(1 − a²)·n,
 * a = exp(−V·dt / L), which keeps the variance at σ² for any step size.
 */
import { gaussian, makeRng, type V3 } from "./math.ts";

export const TURBULENCE_LEVELS = { off: 0, light: 1, moderate: 2.5, severe: 5 } as const;
export type TurbulenceLevel = keyof typeof TURBULENCE_LEVELS;

/** Correlation length, m (the MIL-F-8785C value above 2000 ft). */
export const TURB_LENGTH = 533;

export class Turbulence {
  sigma: number;
  gust: V3 = [0, 0, 0];
  private rand: () => number;

  constructor(sigma: number, seed = 1) {
    this.sigma = sigma;
    this.rand = makeRng(seed);
  }

  step(V: number, dt: number): V3 {
    if (this.sigma <= 0) return (this.gust = [0, 0, 0]);
    const a = Math.exp(-(Math.max(V, 1) * dt) / TURB_LENGTH);
    const k = this.sigma * Math.sqrt(1 - a * a);
    const g = this.gust;
    this.gust = [a * g[0] + k * gaussian(this.rand), a * g[1] + k * gaussian(this.rand), a * g[2] + k * gaussian(this.rand)];
    return this.gust;
  }
}
