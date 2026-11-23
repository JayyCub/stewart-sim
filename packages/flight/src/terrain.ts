/**
 * Procedural terrain for the flight game: one deterministic height function of (north, east)
 * in metres, used both to draw the ground and to detect a crash, so what you see is what you
 * hit. Fractal value noise, softly capped so nothing rises above TERRAIN_MAX (the scripted
 * manoeuvres fly at 1000 m and must never meet a hill).
 *
 * rawHeight < 0 is lake bed; the ground (and the water surface) is at max(0, raw).
 */

export const TERRAIN_MAX = 850;

function hash(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Smoothly interpolated lattice noise in [0, 1). */
export function valueNoise(x: number, y: number, seed = 0): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smooth(x - ix), fy = smooth(y - iy);
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed), c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Fractal sum of octaves, roughly in [0, 1). */
export function fbm(x: number, y: number, octaves: number, seed = 0): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + o * 17);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/** Terrain height before the water cut, m. Negative = under a lake. */
export function rawHeight(north: number, east: number): number {
  const hills = (fbm(east / 7000, north / 7000, 5, 1) - 0.47) * 900;
  // Mountain ranges where a second, slower field is high.
  const range = Math.max(0, fbm(east / 16000, north / 16000, 3, 9) - 0.5) * 2;
  const ridges = range * (1 - Math.abs(fbm(east / 3000, north / 3000, 4, 5) * 2 - 1)) * 1600;
  const h = hills + ridges;
  return h > 0 ? TERRAIN_MAX * Math.tanh(h / TERRAIN_MAX) : h;
}

/** Height of the surface you can hit (ground or water), m. */
export const groundHeight = (north: number, east: number): number => Math.max(0, rawHeight(north, east));
