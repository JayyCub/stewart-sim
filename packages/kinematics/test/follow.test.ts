import { describe, expect, it } from "vitest";
import { DEG, buildLayout, followStep, solve, type Commanded, type Pose } from "../src/index.ts";
import { defaultRig } from "../../rig-config/src/index.ts";

const { geometry: g, limits: lim, collision: col } = defaultRig;
const layout = buildLayout(g);
const HOME: Pose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };
const at = (pose: Pose): Commanded => ({ pose, alphaDeg: solve(layout, g, lim, pose, col).legs.map((l) => l.alpha / DEG) });

/** Run followStep until it stops; returns every frame and the final result. */
function run(from: Commanded, target: Pose, maxStep: number, maxFrames = 5000) {
  const frames: Commanded[] = [];
  let cur = from;
  for (let i = 0; i < maxFrames; i++) {
    const r = followStep(layout, g, lim, cur, target, maxStep, col);
    if (r.kind !== "step") return { frames, last: r, cur };
    frames.push(r.next);
    cur = r.next;
  }
  throw new Error("did not settle");
}

describe("followStep", () => {
  it("does nothing at the target", () => {
    expect(followStep(layout, g, lim, at(HOME), HOME, 1, col).kind).toBe("at-target");
  });

  it("reaches a valid target without any horn exceeding the step limit, every frame valid", () => {
    const target: Pose = { ...HOME, x: 15, z: 8, roll: 6 * DEG, yaw: -10 * DEG };
    expect(solve(layout, g, lim, target, col).ok).toBe(true);
    const { frames, last, cur } = run(at(HOME), target, 1.2);
    expect(last.kind).toBe("at-target");
    expect(frames.length).toBeGreaterThan(5);
    expect(cur.pose).toEqual(target);
    let prev = at(HOME).alphaDeg;
    for (const fr of frames) {
      expect(solve(layout, g, lim, fr.pose, col).ok).toBe(true);
      expect(Math.max(...fr.alphaDeg.map((a, i) => Math.abs(a - prev[i]!)))).toBeLessThanOrEqual(1.2 * 1.001);
      prev = fr.alphaDeg;
    }
  });

  it("stops just short of a limit when the target is out of reach", () => {
    const target: Pose = { ...HOME, z: -200 };
    const { frames, last } = run(at(HOME), target, 1);
    expect(last.kind).toBe("blocked");
    for (const fr of frames) expect(solve(layout, g, lim, fr.pose, col).ok).toBe(true);
    if (last.kind === "blocked") expect(last.leg).toBeGreaterThanOrEqual(0);
  });

  it("refuses a zero speed limit", () => {
    expect(followStep(layout, g, lim, at(HOME), { ...HOME, x: 5 }, 0, col).kind).toBe("blocked");
  });
});
