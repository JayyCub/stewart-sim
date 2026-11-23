import { describe, expect, it } from "vitest";
import { DEG, buildLayout, solve, type Pose } from "../src/index.ts";
import { defaultRig, servoLabel } from "../../rig-config/src/index.ts";

const pose = (p: Partial<Pose> = {}): Pose => ({ x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0, ...p });
const { geometry: g, limits: lim } = defaultRig;
const flat = { ...g, frontDeg: 0 };
const leg = (label: number) => defaultRig.servos.findIndex((_, i) => servoLabel(defaultRig, i) === label);
const angleOf = (v: readonly number[]) => Math.atan2(v[1]!, v[0]!) / DEG;

describe("frontDeg", () => {
  it("is the plain layout when 0 or omitted", () => {
    const { frontDeg: _, ...none } = g;
    expect(buildLayout(flat)).toEqual(buildLayout(none));
  });

  it("turns the whole layout so +x points at the chosen front", () => {
    const a = buildLayout(flat), b = buildLayout({ ...g, frontDeg: 60 });
    expect(b.homeHeight).toBeCloseTo(a.homeHeight, 12);
    for (let i = 0; i < 6; i++) {
      const d = angleOf(b.base[i]!) - angleOf(a.base[i]!);
      expect(((d + 540) % 360) - 180).toBeCloseTo(-60, 9);
      expect(b.platform[i]![2]).toBeCloseTo(a.platform[i]![2], 12);
    }
  });

  it("gives the same horn angles as the unturned rig with the pose turned to match", () => {
    const f = (g.frontDeg ?? 0) * DEG;
    const a = buildLayout(flat), b = buildLayout(g);
    for (const p of [pose({ x: 12 }), pose({ y: -9, z: 5 }), pose({ x: 6, y: 7, yaw: 10 * DEG })]) {
      const turned = pose({ ...p, x: Math.cos(f) * p.x - Math.sin(f) * p.y, y: Math.sin(f) * p.x + Math.cos(f) * p.y });
      const want = solve(a, flat, lim, turned).legs.map((l) => l.alpha);
      solve(b, g, lim, p).legs.forEach((l, i) => expect(l.alpha).toBeCloseTo(want[i]!, 12));
    }
  });

  it("puts the build's front between servos 1 and 6, the back between 3 and 4", () => {
    expect(g.frontDeg).toBe(60);
    const l = buildLayout(g);
    const a1 = angleOf(l.base[leg(1)]!), a6 = angleOf(l.base[leg(6)]!);
    expect(a1).toBeCloseTo(-a6, 9);
    expect(Math.abs(a1)).toBeLessThan(45);
    const a3 = angleOf(l.base[leg(3)]!), a4 = angleOf(l.base[leg(4)]!);
    expect(Math.abs(a3)).toBeGreaterThan(135);
    expect(Math.abs(a4)).toBeGreaterThan(135);
    // Servo 5 is on the +y side, servo 2 on -y.
    expect(Math.abs(angleOf(l.base[leg(5)]!) - 90)).toBeLessThan(2);
    expect(Math.abs(angleOf(l.base[leg(2)]!) + 90)).toBeLessThan(2);
  });

  it("positive pitch lowers the front (servos 1 and 6) equally", () => {
    const sol = solve(buildLayout(g), g, lim, pose({ pitch: 5 * DEG }));
    const home = solve(buildLayout(g), g, lim, pose());
    const dz = (label: number) => sol.legs[leg(label)]!.top[2] - home.legs[leg(label)]!.top[2];
    expect(dz(1)).toBeLessThan(0);
    expect(dz(1)).toBeCloseTo(dz(6), 9);
    expect(dz(3)).toBeGreaterThan(0);
  });
});
