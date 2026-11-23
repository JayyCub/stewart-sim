/**
 * The flight only runs while the rig is live: start() is refused otherwise, and a running
 * flight pauses as soon as the rig stops being live.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlightController, type RigGate } from "../src/flight/controller.ts";

class FakeGate implements RigGate {
  live = false;
  private fns = new Set<() => void>();
  ready = () => this.live;
  subscribe(fn: () => void) {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  set(live: boolean) {
    this.live = live;
    for (const fn of this.fns) fn();
  }
}

beforeEach(() => {
  const target = { addEventListener: () => {}, removeEventListener: () => {} };
  vi.stubGlobal("window", target);
  vi.stubGlobal("document", { ...target, visibilityState: "visible" });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => vi.unstubAllGlobals());

describe("flight needs the rig", () => {
  it("refuses to start until the rig is live", () => {
    const gate = new FakeGate();
    const f = new FlightController(gate);
    expect(f.status.rigReady).toBe(false);
    expect(f.start()).toBe(false);
    expect(f.status.running).toBe(false);
    gate.set(true);
    expect(f.status.rigReady).toBe(true);
    expect(f.start()).toBe(true);
    expect(f.status.running).toBe(true);
  });

  it("pauses the moment the rig stops being live, and says why", () => {
    const gate = new FakeGate();
    gate.live = true;
    const f = new FlightController(gate);
    f.start();
    gate.set(false);
    expect(f.status.running).toBe(false);
    expect(f.status.rigDropped).toBe(true);
    expect(f.start()).toBe(false); // can't resume until it is live again
    gate.set(true);
    expect(f.start()).toBe(true);
    expect(f.status.rigDropped).toBe(false);
  });

  it("a pause the pilot asked for is not reported as a rig drop", () => {
    const gate = new FakeGate();
    gate.live = true;
    const f = new FlightController(gate);
    f.start();
    f.pause();
    gate.set(false); // e.g. Esc also stopped the rig
    expect(f.status.rigDropped).toBe(false);
  });
});
