import { describe, expect, it } from "vitest";
import { buildLayout, solve } from "@stewart/kinematics";
import { RigConfigError, defaultRig, parseRigConfig, parseRigJson } from "../src/index.ts";

describe("rig config", () => {
  it("ships a valid, buildable default", () => {
    const layout = buildLayout(defaultRig.geometry);
    expect(layout.homeHeight).toBeGreaterThan(0);
    expect(solve(layout, defaultRig.geometry, defaultRig.limits, { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 }).ok).toBe(true);
  });

  it("lists every problem in a bad config", () => {
    const bad = structuredClone(defaultRig) as unknown as Record<string, any>;
    bad.geometry.rodLength = -5;
    bad.limits.servoMinDeg = 80;
    bad.servos[1].channel = 0;
    bad.servos[2].direction = 0;
    try {
      parseRigConfig(bad);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RigConfigError);
      const msg = (e as Error).message;
      expect(msg).toContain("geometry.rodLength");
      expect(msg).toContain("servoMinDeg must be below");
      expect(msg).toContain("used twice");
      expect(msg).toContain("servos[2].direction");
    }
  });

  it("rejects a config without six servos", () => {
    expect(() => parseRigConfig({ ...defaultRig, servos: [] })).toThrow(/exactly 6/);
  });

  it("round-trips rig.json text", () => {
    expect(parseRigJson(JSON.stringify(defaultRig))).toEqual(defaultRig);
  });

  it("reports text that is not JSON as a RigConfigError", () => {
    expect(() => parseRigJson("{ geometry: ")).toThrow(RigConfigError);
    expect(() => parseRigJson("{ geometry: ")).toThrow(/Not valid JSON/);
  });

  it("validates parsed text like any other config", () => {
    expect(() => parseRigJson("[]")).toThrow(/must be a JSON object/);
  });

  it("fills in collision defaults for an older rig.json without them", () => {
    const { collision: _, ...old } = structuredClone(defaultRig);
    const rig = parseRigConfig({ ...old, collision: { rodRadius: 3 } });
    expect(rig.collision.rodRadius).toBe(3);
    expect(rig.collision.servoWidth).toBe(19.7);
    expect(parseRigConfig(old).collision).toEqual(defaultRig.collision);
  });

  it("rejects bad collision values", () => {
    expect(() => parseRigConfig({ ...defaultRig, collision: { servoWidth: 0, minClearance: -1 } })).toThrow(/servoWidth must be positive[\s\S]*minClearance must not be negative/);
  });

  it("accepts a rig.json without mount orientation and checks it when present", () => {
    const { servoYawDeg: _y, servoTiltDeg: _t, topStudTiltDeg: _s, ...plain } = defaultRig.geometry;
    expect(parseRigConfig({ ...defaultRig, geometry: plain }).geometry.servoYawDeg).toBeUndefined();
    expect(() => parseRigConfig({ ...defaultRig, geometry: { ...plain, servoTiltDeg: 120 } })).toThrow(/servoTiltDeg must be a number from -75 to 75/);
  });
});
