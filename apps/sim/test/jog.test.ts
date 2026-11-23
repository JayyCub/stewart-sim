import { beforeEach, describe, expect, it } from "vitest";
import { DEG, buildLayout, solve, type Pose } from "@stewart/kinematics";
import { defaultRig, type RigConfig } from "@stewart/rig-config";
import { JogController, MAX_STEP_MS } from "../src/hardware/jog.ts";
import { FRAME_MS } from "../src/hardware/link.ts";
import { FakeUno } from "./fake-uno.ts";

/** rig.json with the limits these tests were written against, so they don't move when rig.json does. */
const rig: RigConfig = {
  ...defaultRig,
  limits: { ...defaultRig.limits, servoMinDeg: -75, servoMaxDeg: 70, ballSwivelDeg: 30 },
  collision: { ...defaultRig.collision, hornRodMinDeg: 8 },
};
const layout = buildLayout(rig.geometry);
const toDeg = (r: RigConfig, us: number[]) => r.servos.map((s) => (us[s.channel]! - s.centerUs - s.trimUs) / (s.direction * s.usPerDeg));

let uno: FakeUno;
let loaded: RigConfig;
let shown: Pose | null;
/** Extra ms the next sleep takes, to fake a frozen tab mid-move. */
let stallMs = 0;
let jog: JogController;

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function until(cond: () => boolean, what: string, max = 50000) {
  for (let i = 0; i < max; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}
const settled = () => until(() => jog.status.phase === "ready", "move to finish");

beforeEach(() => {
  uno = new FakeUno();
  loaded = rig;
  shown = null;
  jog = new JogController({
    getRig: () => loaded,
    showPose: (p) => void (shown = p),
    sleep: (ms) => {
      uno.now += ms + stallMs;
      stallMs = 0;
      return tick();
    },
    now: () => uno.now,
  });
});

async function connectAndLevel() {
  await jog.connect(uno);
  expect(jog.status.phase).toBe("unknown");
  await jog.level();
  expect(jog.status.phase).toBe("ready");
}

/** No horn moved more than one jog step (speed × frame time) between frames. */
function checkSpeed(frameMs = FRAME_MS) {
  const allowed = jog.status.speed * (frameMs / 1000) + 0.1; // +0.1: whole microseconds
  for (let k = 1; k < uno.output.length; k++) {
    const a = toDeg(rig, uno.output[k - 1]!), b = toDeg(rig, uno.output[k]!);
    expect(Math.max(...a.map((d, i) => Math.abs(d - b[i]!)))).toBeLessThanOrEqual(allowed);
  }
}

describe("jog control", () => {
  it("levels every horn in one frame", async () => {
    await connectAndLevel();
    expect(uno.commands).toContain("A 1500 1500 1500 1500 1500 1500");
    expect(jog.status.alphaDeg).toEqual([0, 0, 0, 0, 0, 0]);
    expect(jog.status.faults!.every((f) => f.length === 0)).toBe(true);
  });

  it("ramps one servo at the jog speed and leaves the others alone", async () => {
    await connectAndLevel();
    jog.setAngle(2, 6);
    await settled();
    checkSpeed();
    expect(uno.output.length).toBeGreaterThan(10);
    const end = toDeg(rig, uno.holding!);
    end.forEach((d, i) => expect(d).toBeCloseTo(i === 2 ? 6 : 0, 1));
    // The 3D view shows the model's pose for those horn angles.
    const back = solve(layout, rig.geometry, rig.limits, shown!).legs.map((l) => l.alpha / DEG);
    back.forEach((d, i) => expect(d).toBeCloseTo(jog.status.alphaDeg![i]!, 6));
  });

  it("stops just short of the model's limits unless told to go past them", async () => {
    await connectAndLevel();
    jog.setSpeed(rig.motion!.maxHornDegPerSec);
    jog.setAngle(0, -120);
    await settled();
    expect(jog.status.stoppedBy).toMatch(/servo 2/);
    expect(jog.status.faults!.every((f) => f.length === 0)).toBe(true);
    const held = jog.status.alphaDeg![0]!;
    expect(held).toBeGreaterThan(-120);
    expect(jog.status.target![0]).toBe(held); // the slider snaps back to where the servo stopped

    jog.setBeyond(true);
    jog.setAngle(0, held - 3);
    await settled();
    expect(jog.status.alphaDeg![0]!).toBeCloseTo(held - 3, 6);
    expect(jog.status.faults === null || jog.status.faults.some((f) => f.length > 0)).toBe(true);
  });

  it("never sends a pulse outside the firmware window, even past the limits", async () => {
    await connectAndLevel();
    jog.setBeyond(true);
    jog.setSpeed(rig.motion!.maxHornDegPerSec);
    jog.setAngle(1, 150); // 1500 us + 1500 us would be far outside 500-2500
    await settled();
    expect(jog.status.stoppedBy).toMatch(/firmware window/);
    for (const f of uno.output) for (const u of f) expect(u >= 500 && u <= 2500).toBe(true);
  });

  it("Stop holds the frame sent last; home ramps back to level", async () => {
    await connectAndLevel();
    jog.setAngle(3, 20);
    await until(() => (jog.status.alphaDeg?.[3] ?? 0) > 2, "partway");
    await jog.stop();
    expect(jog.status.phase).toBe("ready");
    const held = jog.status.alphaDeg![3]!;
    expect(held).toBeLessThan(20);
    expect(toDeg(rig, uno.holding!)[3]).toBeCloseTo(held, 1);

    jog.home();
    await settled();
    checkSpeed();
    expect(uno.holding).toEqual([1500, 1500, 1500, 1500, 1500, 1500]);
  });

  it("a stalled browser slows the ramp instead of making the servo jump", async () => {
    await connectAndLevel();
    jog.setAngle(2, 10);
    await until(() => (jog.status.alphaDeg?.[2] ?? 0) > 1, "partway");
    stallMs = 5000; // the tab freezes for 5 s mid-move
    await settled();
    expect(stallMs).toBe(0);
    checkSpeed(MAX_STEP_MS);
  });

  it("loading a different rig.json drops to unknown instead of jumping to new calibration", async () => {
    await connectAndLevel();
    loaded = { ...rig, servos: rig.servos.map((s) => ({ ...s, trimUs: 40 })) };
    const before = uno.output.length;
    jog.setAngle(0, 2);
    expect(jog.status.phase).toBe("unknown");
    expect(uno.output.length).toBe(before);
  });
});
