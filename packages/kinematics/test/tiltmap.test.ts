import { describe, expect, it } from "vitest";
import { DEG, TILT_BALL, TILT_OK, TILT_SERVO, buildLayout, solve, tiltAt, tiltMap, workspace, type Geometry, type Limits, type Pose } from "../src/index.ts";

const geo: Geometry = {
  baseRadius: 85, platformRadius: 60, baseHalfAngleDeg: 15, platformHalfAngleDeg: 30, hornLength: 22, rodLength: 120,
};
const lim: Limits = { servoMinDeg: -70, servoMaxDeg: 70, ballSwivelDeg: 30 };
const layout = buildLayout(geo);
const HOME: Pose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };
const map = tiltMap(layout, geo, lim, HOME, 35 * DEG, 71);
const cell = (row: number, col: number) => map.cells[row * map.n + col];
const mid = (map.n - 1) / 2;

describe("tilt map", () => {
  it("is reachable at the centre and blocked at the corners", () => {
    expect(cell(mid, mid)).toBe(TILT_OK);
    expect(cell(0, 0)).not.toBe(TILT_OK);
    expect(cell(map.n - 1, map.n - 1)).not.toBe(TILT_OK);
  });

  it("puts roll on columns and pitch on rows", () => {
    expect(tiltAt(map, mid, mid)).toEqual({ roll: 0, pitch: 0 });
    const { roll, pitch } = tiltAt(map, 0, map.n - 1);
    expect(roll).toBeCloseTo(35 * DEG, 12);
    expect(pitch).toBeCloseTo(-35 * DEG, 12);
  });

  it("agrees with solve() cell by cell", () => {
    for (const [row, col] of [[mid, 0], [3, 50], [60, 12], [mid + 5, mid - 9]] as const) {
      const ok = solve(layout, geo, lim, { ...HOME, ...tiltAt(map, row, col) }).ok;
      expect(cell(row, col) === TILT_OK).toBe(ok);
    }
  });

  it("matches the single-axis roll reach along the centre row", () => {
    const ws = workspace(layout, geo, lim);
    for (let col = 0; col < map.n; col++) {
      const { roll } = tiltAt(map, mid, col);
      if (roll > ws.roll.min + 1e-9 && roll < ws.roll.max - 1e-9) expect(cell(mid, col)).toBe(TILT_OK);
      if (roll < ws.roll.min - 1e-9 || roll > ws.roll.max + 1e-9) expect(cell(mid, col)).not.toBe(TILT_OK);
    }
  });

  it("is mirror-symmetric in roll", () => {
    for (let row = 0; row < map.n; row++)
      for (let col = 0; col < map.n; col++) expect(cell(row, col)).toBe(cell(row, map.n - 1 - col));
  });

  it("names the limit that blocks a cell", () => {
    const tightServo = tiltMap(layout, geo, { ...lim, servoMinDeg: -5, servoMaxDeg: 5, ballSwivelDeg: 89 }, HOME, 12 * DEG, 21);
    expect(tightServo.cells[0]).toBe(TILT_SERVO);
    const tightBall = tiltMap(layout, geo, { ...lim, servoMinDeg: -89, servoMaxDeg: 89, ballSwivelDeg: 5 }, HOME, 12 * DEG, 21);
    expect(tightBall.cells[0]).toBe(TILT_BALL);
  });

  it("keeps x, y, z and yaw from the base pose", () => {
    const raised = tiltMap(layout, geo, lim, { ...HOME, z: 15 }, 35 * DEG, 71);
    const ok = (m: typeof map) => m.cells.filter((c) => c === TILT_OK).length;
    expect(ok(raised)).not.toBe(ok(map));
  });
});
