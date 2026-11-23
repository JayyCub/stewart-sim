import { beforeEach, describe, expect, it } from "vitest";
import { DEG, buildLayout, solve, type Pose } from "@stewart/kinematics";
import { defaultRig, type RigConfig } from "@stewart/rig-config";
import { HOME, LiveController } from "../src/hardware/live.ts";
import { FRAME_MS } from "../src/hardware/link.ts";
import { FakeUno } from "./fake-uno.ts";

const rig = defaultRig;
const layout = buildLayout(rig.geometry);
const maxHorn = rig.motion!.maxHornDegPerSec;
/** Pulses by channel -> horn angles in leg order (inverse of frameUs). */
const toDeg = (r: RigConfig, us: number[]) => r.servos.map((s) => (us[s.channel]! - s.centerUs - s.trimUs) / (s.direction * s.usPerDeg));

let uno: FakeUno;
let target: Pose;
let loaded: RigConfig;
let live: LiveController;

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function until(cond: () => boolean, what: string, max = 20000) {
  for (let i = 0; i < max; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeEach(() => {
  uno = new FakeUno();
  target = HOME;
  loaded = rig;
  live = new LiveController({
    getTarget: () => target,
    getRig: () => loaded,
    setTarget: (p) => void (target = p),
    sleep: (ms) => {
      uno.now += ms;
      uno.advance();
      return tick();
    },
  });
});

async function connectAndLevel() {
  await live.connect(uno);
  expect(live.status.phase).toBe("unknown");
  await live.level();
  expect(live.status.phase).toBe("live");
}

/** Every frame the servos received is a valid pose's horn angles and no horn moved too fast. */
function checkOutput(speed: number) {
  const allowed = maxHorn * speed * (FRAME_MS / 1000) * 1.001 + 0.1; // +0.1: pulses are whole microseconds
  let prev: number[] | null = null;
  for (const us of uno.output) {
    const deg = toDeg(rig, us);
    for (const d of deg) expect(d).toBeGreaterThanOrEqual(rig.limits.servoMinDeg - 0.1);
    for (const d of deg) expect(d).toBeLessThanOrEqual(rig.limits.servoMaxDeg + 0.1);
    if (prev) expect(Math.max(...deg.map((d, i) => Math.abs(d - prev![i]!)))).toBeLessThanOrEqual(allowed);
    prev = deg;
  }
}

describe("live control", () => {
  it("connects, levels every horn in one frame and resets the sim pose to home", async () => {
    target = { ...HOME, x: 12 };
    await connectAndLevel();
    expect(uno.commands).toContain("A 1500 1500 1500 1500 1500 1500");
    expect(target).toEqual(HOME);
    await live.disconnect();
  });

  it("refuses firmware that is not servo_test v3", async () => {
    uno.firmware = "READY servo_test v2";
    await live.connect(uno);
    expect(live.status.phase).toBe("disconnected");
    expect(live.status.message?.text).toMatch(/servo_test v3/);
  });

  it("follows the target at the horn speed limit with every frame valid", async () => {
    await connectAndLevel();
    target = { ...HOME, x: 15, z: 6, pitch: 5 * DEG };
    await until(() => live.status.commanded?.pose.x === 15 && uno.commands.at(-1) === "E", "target reached");
    await until(() => uno.output.length > 0 && toDeg(rig, uno.holding!).every((d, i) => Math.abs(d - live.status.commanded!.alphaDeg[i]!) < 0.1), "queue played out");
    expect(uno.output.length).toBeGreaterThan(10);
    checkOutput(live.status.speed);
    const want = solve(layout, rig.geometry, rig.limits, target, rig.collision).legs.map((l) => l.alpha / DEG);
    toDeg(rig, uno.holding!).forEach((d, i) => expect(d).toBeCloseTo(want[i]!, 0));
    expect(live.status.underruns).toBe(0);
    await live.disconnect();
  });

  it("ignores a target that fails the checks and stops short of the limit", async () => {
    await connectAndLevel();
    target = { ...HOME, z: -200 };
    await until(() => live.status.targetRejected, "target rejected");
    expect(uno.commands.filter((c) => c.startsWith("Q"))).toHaveLength(0);

    // Drag the heave slider down past reach: the rig parks at the last valid target.
    let lastOk = 0;
    for (let z = 0; z >= -60; z -= 0.5) {
      target = { ...HOME, z };
      if (solve(layout, rig.geometry, rig.limits, target, rig.collision).ok) lastOk = z;
      for (let i = 0; i < 3; i++) await tick();
    }
    expect(lastOk).toBeGreaterThan(-60);
    expect(live.status.targetRejected).toBe(true);
    await until(() => live.status.commanded?.pose.z === lastOk, "parked at the last valid target");
    expect(uno.output.length).toBeGreaterThan(10);
    checkOutput(live.status.speed);
    await live.disconnect();
  });

  it("stops at once, holds the frame playing now, and points the sim at it", async () => {
    await connectAndLevel();
    live.setSpeed(0.2);
    target = { ...HOME, y: 20 };
    await until(() => live.status.queued >= 3, "queue filling");
    await live.stop();
    expect(live.status.phase).toBe("held");
    const held = live.status.commanded!;
    expect(held.pose.y).toBeGreaterThan(0);
    expect(held.pose.y).toBeLessThan(20);
    expect(target).toEqual(held.pose);
    // What the servos hold is exactly the pose we think they hold.
    toDeg(rig, uno.holding!).forEach((d, i) => expect(d).toBeCloseTo(held.alphaDeg[i]!, 0));
    // Nothing moves after the stop.
    const n = uno.output.length;
    for (let i = 0; i < 20; i++) await tick();
    expect(uno.output.length).toBe(n);

    target = { ...HOME, y: 20 };
    live.resume();
    await until(() => live.status.commanded?.pose.y === 20, "resumed to target");
    checkOutput(0.2);
    await live.disconnect();
  });

  it("releases every servo and requires Level again", async () => {
    await connectAndLevel();
    await live.release();
    expect(live.status.phase).toBe("unknown");
    expect(uno.commands.filter((c) => c.startsWith("O ")).sort()).toEqual(["O 0", "O 1", "O 2", "O 3", "O 4", "O 5"]);
  });

  it("refuses to start without a horn speed limit in rig.json", async () => {
    loaded = { ...rig, motion: undefined };
    await live.connect(uno);
    await live.level();
    expect(live.status.phase).toBe("unknown");
    expect(live.status.message?.text).toMatch(/maxHornDegPerSec/);
    expect(uno.commands.some((c) => c.startsWith("A"))).toBe(false);
  });

  it("drops to unknown (servos holding) on a firmware error", async () => {
    await connectAndLevel();
    uno.failOn = "Q";
    target = { ...HOME, x: 5 };
    await until(() => live.status.phase === "unknown", "fault");
    expect(live.status.message?.bad).toBe(true);
    expect(uno.commands.at(-1)).toBe("F");
  });

  it("stops when a different rig.json is loaded", async () => {
    await connectAndLevel();
    loaded = structuredClone(rig);
    await until(() => live.status.phase === "unknown", "rig change stop");
    expect(live.status.message?.text).toMatch(/different rig/);
  });
});
