import { describe, expect, it } from "vitest";
import { DEFAULT_COLLISION, buildLayout, solve } from "@stewart/kinematics";
import { FIRMWARE_MAX_US, FIRMWARE_MIN_US, RigConfigError, defaultRig, degToUs, frameUs, parseRigConfig, parseRigJson, servoLabel } from "../src/index.ts";

describe("rig config", () => {
  it("ships a valid, buildable default", () => {
    const layout = buildLayout(defaultRig.geometry);
    expect(layout.homeHeight).toBeGreaterThan(0);
    expect(solve(layout, defaultRig.geometry, defaultRig.limits, { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 }).ok).toBe(true);
  });

  it("lists every problem in a bad config", () => {
    const bad = structuredClone(defaultRig) as unknown as Record<string, any>;
    bad.geometry.rodLength = -5;
    bad.limits.servoMinDeg = bad.limits.servoMaxDeg + 10;
    bad.servos[1].channel = bad.servos[0].channel;
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
    expect(parseRigConfig(old).collision).toEqual(DEFAULT_COLLISION);
  });

  it("accepts a rig.json without motion limits and checks them when present", () => {
    const { motion: _, ...old } = structuredClone(defaultRig);
    expect(parseRigConfig(old).motion).toBeUndefined();
    expect(() => parseRigConfig({ ...defaultRig, motion: { maxHornDegPerSec: 0 } })).toThrow(/maxHornDegPerSec/);
    expect(() => parseRigConfig({ ...defaultRig, motion: 5 })).toThrow(/motion must be an object/);
  });

  it("defaults servo labels to leg + 1 and rejects bad or repeated labels", () => {
    const unlabelled = structuredClone(defaultRig);
    unlabelled.servos.forEach((sv) => delete sv.label);
    expect(parseRigConfig(unlabelled).servos.map((_, i) => servoLabel(unlabelled, i))).toEqual([1, 2, 3, 4, 5, 6]);
    const bad = structuredClone(defaultRig);
    bad.servos[0]!.label = 7;
    bad.servos[2]!.label = bad.servos[1]!.label;
    expect(() => parseRigConfig(bad)).toThrow(/servos\[0\]\.label must be an integer 1\.\.6[\s\S]*servos\[2\]\.label \d is used twice/);
  });

  it("rejects a negative shaftFromSide", () => {
    expect(() => parseRigConfig({ ...defaultRig, collision: { shaftFromSide: -1 } })).toThrow(/shaftFromSide must not be negative/);
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

describe("pulse frames", () => {
  it("maps horn angles to pulses by channel, honouring direction and trim", () => {
    const rig = structuredClone(defaultRig);
    rig.servos[0]!.trimUs = 12;
    const degs = [10, -5, 0, 3, 0, 20];
    const us = frameUs(rig, degs);
    const s0 = rig.servos[0]!;
    expect(us[s0.channel]).toBe(s0.centerUs + 12 + s0.direction * s0.usPerDeg * 10);
    rig.servos.forEach((s, i) => expect(us[s.channel]).toBe(degToUs(s, degs[i]!)));
  });

  it("refuses a pulse outside the firmware window", () => {
    expect(() => frameUs(defaultRig, [150, 0, 0, 0, 0, 0])).toThrow(RigConfigError);
    expect(() => frameUs(defaultRig, [0, 0, 0, 0, 0])).toThrow(/6 horn angles/);
  });

  it("refuses servos that are not on channels 0-5", () => {
    const rig = structuredClone(defaultRig);
    rig.servos[0]!.channel = 9;
    expect(() => frameUs(rig, [0, 0, 0, 0, 0, 0])).toThrow(/channels 0-5/);
  });

  it("matches the firmware window constants", () => {
    expect([FIRMWARE_MIN_US, FIRMWARE_MAX_US]).toEqual([500, 2500]);
  });
});
