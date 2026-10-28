import { solve } from "./ik.ts";
import type { Collision, Geometry, Layout, Limits, Pose, Solution } from "./types.ts";

/** What stops a tilt map cell, in priority order: the first fault found on any leg wins. */
export const TILT_OK = 0;
export const TILT_NO_SOLUTION = 1;
export const TILT_SERVO = 2;
export const TILT_BALL = 3;
export const TILT_COLLISION = 4;
export type TiltCell = typeof TILT_OK | typeof TILT_NO_SOLUTION | typeof TILT_SERVO | typeof TILT_BALL | typeof TILT_COLLISION;

export interface TiltMap {
  /** Cells per side; the grid is n × n with the centre cell at roll = pitch = 0. */
  n: number;
  /** Half-width of the grid in radians: cells span -range..+range on both axes. */
  range: number;
  /** Row-major, row = pitch index (from -range), column = roll index (from -range). */
  cells: Uint8Array;
}

function classify(sol: Solution): TiltCell {
  if (sol.ok) return TILT_OK;
  const faults = sol.legs.flatMap((l) => l.faults);
  if (faults.includes("no-solution")) return TILT_NO_SOLUTION;
  if (faults.includes("servo-range")) return TILT_SERVO;
  if (faults.some((f) => f === "servo-clash" || f === "rod-hits-servo" || f === "rod-hits-horn")) return TILT_COLLISION;
  return TILT_BALL;
}

/**
 * Roll × pitch reachability around a base pose. Roll and pitch of the base
 * pose are replaced by the grid values; x, y, z and yaw are kept, so the map
 * answers "how far can the platform tilt from here".
 */
export function tiltMap(layout: Layout, g: Geometry, lim: Limits, base: Pose, range: number, n = 61, col?: Collision): TiltMap {
  const cells = new Uint8Array(n * n);
  const at = (i: number) => -range + (2 * range * i) / (n - 1);
  for (let row = 0; row < n; row++) {
    for (let c = 0; c < n; c++) {
      cells[row * n + c] = classify(solve(layout, g, lim, { ...base, roll: at(c), pitch: at(row) }, col));
    }
  }
  return { n, range, cells };
}

/** Roll and pitch (radians) at the centre of a cell. */
export function tiltAt(map: TiltMap, row: number, col: number): { roll: number; pitch: number } {
  const step = (2 * map.range) / (map.n - 1);
  return { roll: -map.range + col * step, pitch: -map.range + row * step };
}
