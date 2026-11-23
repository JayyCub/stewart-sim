/**
 * End-to-end: every scripted manoeuvre, flown by the same FlightSim the app uses, through
 * washout and the rig's limiter. The safety property is that every pose leaving the limiter
 * passes the full rig check; the rest pins down that each manoeuvre does what it says.
 */
import { describe, expect, it } from "vitest";
import { FlightSim, SCENARIOS, type Telemetry } from "../src/index.ts";
import { PoseLimiter, buildLayout, limitPose, solve } from "../../kinematics/src/index.ts";
import { defaultRig } from "../../rig-config/src/index.ts";

const { geometry: g, limits: lim, collision: col } = defaultRig;
const layout = buildLayout(g);
const DEG = Math.PI / 180;
const byId = (id: string) => SCENARIOS.find((s) => s.id === id)!;

function fly(id: string): Telemetry[] {
  const sc = byId(id);
  const sim = new FlightSim(sc);
  const out: Telemetry[] = [];
  while (sim.t < sc.duration - 1e-9) out.push(sim.tick());
  return out;
}

const flights = Object.fromEntries(SCENARIOS.filter((s) => s.id !== "free").map((s) => [s.id, fly(s.id)]));

describe("scripted manoeuvres through washout and the rig limiter", () => {
  for (const [id, tel] of Object.entries(flights)) {
    it(`${id}: every limited pose passes the rig's IK, servo, ball-joint and collision checks`, () => {
      const limiter = new PoseLimiter(1);
      for (const t of tel) {
        const lp = limiter.limit(layout, g, lim, t.cue, 0.01, col);
        expect(lp.ok).toBe(true);
        expect(solve(layout, g, lim, lp.pose, col).ok).toBe(true);
      }
    });
  }

  it("coordinated turn: holds 30° bank and altitude, with almost no sideways force on the pilot", () => {
    const tel = flights["turn"]!;
    const steady = tel.filter((t) => t.t > 10 && t.t < 22);
    for (const t of steady) {
      expect(Math.abs(t.euler[0] - 30 * DEG)).toBeLessThan(1 * DEG);
      expect(Math.abs(t.air.beta)).toBeLessThan(1 * DEG);
      expect(Math.abs(t.fPilot[1])).toBeLessThan(0.3);
    }
    for (const t of tel) expect(Math.abs(t.alt - 1000)).toBeLessThan(5);
    // Load factor in a 30° level turn is 1/cos 30° ≈ 1.155 g.
    const nz = steady.reduce((s, t) => s - t.fPilot[2], 0) / steady.length / 9.80665;
    expect(nz).toBeCloseTo(1 / Math.cos(30 * DEG), 1);
    // The platform cues the roll-in, then washes out: no sustained tilt.
    expect(Math.max(...tel.map((t) => Math.abs(t.cue.roll)))).toBeGreaterThan(0.5 * DEG);
    expect(Math.abs(tel.find((t) => t.t > 21.9)!.cue.roll)).toBeLessThan(0.3 * DEG);
  });

  it("full power: the aircraft accelerates and the platform holds a backward tilt for the sustained push", () => {
    const tel = flights["power"]!;
    expect(tel.at(-1)!.air.Va).toBeGreaterThan(55);
    const mid = tel.find((t) => t.t > 8)!;
    expect(mid.fPilot[0]).toBeGreaterThan(0.8);
    expect(mid.cue.pitch).toBeLessThan(-3 * DEG);
  });

  it("doublet: hands-off afterwards, the phugoid shows up as a slow altitude swing", () => {
    const tel = flights["doublet"]!.filter((t) => t.t > 10);
    const alts = tel.map((t) => t.alt);
    expect(Math.max(...alts) - Math.min(...alts)).toBeGreaterThan(2);
  });

  it("turbulence: autopilot keeps wings level and altitude, and the platform moves", () => {
    const tel = flights["turbulence"]!;
    for (const t of tel) expect(Math.abs(t.euler[0])).toBeLessThan(5 * DEG);
    for (const t of tel) expect(Math.abs(t.alt - 1000)).toBeLessThan(20);
    expect(Math.max(...tel.map((t) => Math.abs(t.cue.z)))).toBeGreaterThan(2);
  });

  it("is deterministic: the same scenario flies the same way twice", () => {
    const a = fly("turbulence"), b = flights["turbulence"]!;
    expect(a.at(-1)!.state).toEqual(b.at(-1)!.state);
  });

  it("advance() runs whole fixed steps whatever the frame rate", () => {
    const sim = new FlightSim(byId("turn"));
    let n = 0;
    for (let i = 0; i < 60; i++) n += sim.advance(1 / 60).length;
    expect(n).toBeGreaterThanOrEqual(99);
    expect(n).toBeLessThanOrEqual(100);
  });
});

describe("PoseLimiter", () => {
  it("cuts the scale at once but gives it back no faster than the recovery rate", () => {
    const limiter = new PoseLimiter(1);
    const far = { x: 0, y: 0, z: 200, roll: 0, pitch: 0, yaw: 0 };
    const small = { x: 0, y: 0, z: 5, roll: 0, pitch: 0, yaw: 0 };
    const cut = limiter.limit(layout, g, lim, far, 0.01, col).scale;
    expect(cut).toBeLessThan(0.5);
    // The cue drops back into reach: the scale climbs 0.01 per 10 ms step, not straight to 1.
    const next = limiter.limit(layout, g, lim, small, 0.01, col);
    expect(next.scale).toBeCloseTo(cut + 0.01, 9);
    expect(next.pose.z).toBeCloseTo(5 * (cut + 0.01), 9);
    for (let i = 0; i < 200; i++) limiter.limit(layout, g, lim, small, 0.01, col);
    expect(limiter.scale).toBe(1);
  });
});

describe("limitPose", () => {
  it("keeps a valid pose untouched and scales an invalid one to a valid pose on the same line", () => {
    const ok = { x: 5, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };
    expect(limitPose(layout, g, lim, ok, col)).toEqual({ pose: ok, scale: 1, ok: true });
    const far = { x: 0, y: 0, z: 200, roll: 0.5, pitch: 0, yaw: 0 };
    const r = limitPose(layout, g, lim, far, col);
    expect(r.scale).toBeGreaterThan(0);
    expect(r.scale).toBeLessThan(1);
    expect(solve(layout, g, lim, r.pose, col).ok).toBe(true);
    expect(r.pose.roll / r.pose.z).toBeCloseTo(0.5 / 200, 12);
  });
});
