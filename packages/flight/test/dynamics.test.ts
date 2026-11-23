import { describe, expect, it } from "vitest";
import {
  G0, LIGHT_AIRCRAFT, angularMomentumNed, derivative, quatFromEuler, rotationalEnergy, specificForceAt, step, type Aircraft, type State,
} from "../src/index.ts";
import { actuate } from "../src/dynamics.ts";
import { eulerFromQuat, qrotate } from "../src/math.ts";

/** Same mass properties, no air and no engine: a rigid body in a vacuum. */
const VACUUM: Aircraft = { ...LIGHT_AIRCRAFT, S: 0, thrustStatic: 0, powerEff: 0 };
const NEUTRAL = { de: 0, da: 0, dr: 0, throttle: 0 };

describe("rigid-body equations of motion", () => {
  it("conserves rotational energy and angular momentum when no torque acts (tumbling, all three axes)", () => {
    let s: State = { pos: [0, 0, -1000], vel: [0, 0, 0], q: quatFromEuler(0.3, -0.2, 1), w: [1.0, 0.2, 0.5] };
    const E0 = rotationalEnergy(VACUUM, s.w);
    const H0 = angularMomentumNed(VACUUM, s);
    for (let i = 0; i < 2000; i++) s = step(VACUUM, s, NEUTRAL, 0.005); // 10 s
    expect(rotationalEnergy(VACUUM, s.w) / E0).toBeCloseTo(1, 7);
    const H = angularMomentumNed(VACUUM, s);
    for (let k = 0; k < 3; k++) expect(H[k]!).toBeCloseTo(H0[k]!, 3);
  });

  it("free fall: velocity in NED grows by g·t while the body tumbles", () => {
    let s: State = { pos: [0, 0, -1000], vel: [10, 0, 0], q: quatFromEuler(0, 0.1, 0), w: [0.5, -0.3, 0.2] };
    const v0 = qrotate(s.q, s.vel);
    for (let i = 0; i < 500; i++) s = step(VACUUM, s, NEUTRAL, 0.01); // 5 s
    const v = qrotate(s.q, s.vel);
    expect(v[0]).toBeCloseTo(v0[0], 6);
    expect(v[1]).toBeCloseTo(v0[1], 6);
    expect(v[2]).toBeCloseTo(v0[2] + G0 * 5, 6);
    expect(-s.pos[2]).toBeCloseTo(1000 - v0[2] * 5 - 0.5 * G0 * 25, 4);
  });

  it("keeps the attitude quaternion at unit length", () => {
    let s: State = { pos: [0, 0, -1000], vel: [55, 0, 0], q: quatFromEuler(0, 0, 0), w: [0.8, 0.4, -0.6] };
    for (let i = 0; i < 1000; i++) s = step(VACUUM, s, NEUTRAL, 0.01);
    expect(Math.hypot(...s.q)).toBeCloseTo(1, 12);
  });

  it("an accelerometer in free fall reads zero (specific force excludes gravity)", () => {
    const s: State = { pos: [0, 0, -1000], vel: [0, 0, 0], q: quatFromEuler(0, 0, 0), w: [0, 0, 0] };
    for (const v of derivative(VACUUM, s, NEUTRAL).air.f) expect(Math.abs(v)).toBe(0);
  });

  it("specific force away from the CG adds ω̇×r and centripetal ω×(ω×r)", () => {
    const air = { Va: 50, alpha: 0, beta: 0, f: [0, 0, -G0] as const, wdot: [0, 0, 0] as const };
    // Yawing at 1 rad/s, a point 1 m ahead of the CG feels 1 m/s² toward the CG.
    expect(specificForceAt(air, [0, 0, 1], [1, 0, 0])).toEqual([-1, 0, -G0]);
    // Rolling acceleration of 2 rad/s² at a point 0.5 m above the CG pushes it sideways.
    const f = specificForceAt({ ...air, wdot: [2, 0, 0] }, [0, 0, 0], [0, 0, -0.5]);
    expect(f[1]).toBeCloseTo(1, 12);
  });

  it("positive surface deflections give nose up, roll right and nose right", () => {
    const s: State = { pos: [0, 0, -1000], vel: [55, 0, 0], q: quatFromEuler(0, 0, 0), w: [0, 0, 0] };
    const base = derivative(LIGHT_AIRCRAFT, s, NEUTRAL).d.w;
    const d = (u: Partial<typeof NEUTRAL>) => derivative(LIGHT_AIRCRAFT, s, { ...NEUTRAL, ...u }).d.w;
    expect(d({ de: 0.05 })[1]).toBeGreaterThan(base[1]);
    expect(d({ da: 0.05 })[0]).toBeGreaterThan(base[0]);
    expect(d({ dr: 0.05 })[2]).toBeGreaterThan(base[2]);
  });

  it("actuators move no faster than their rate limits", () => {
    const ac = LIGHT_AIRCRAFT;
    let u = { ...NEUTRAL };
    u = actuate(ac, u, { de: 1, da: -1, dr: 1, throttle: 1 }, 0.01);
    expect(u.de).toBeCloseTo(ac.surfaceRate * 0.01, 12);
    expect(u.da).toBeCloseTo(-ac.surfaceRate * 0.01, 12);
    expect(u.throttle).toBeCloseTo(ac.throttleRate * 0.01, 12);
    for (let i = 0; i < 1000; i++) u = actuate(ac, u, { de: 1, da: -1, dr: 1, throttle: 1 }, 0.01);
    expect(u.de).toBe(ac.deMax); // and stops at the travel limit
  });

  it("Euler ↔ quaternion round trip", () => {
    const e = eulerFromQuat(quatFromEuler(0.4, -0.7, 2.5));
    expect(e[0]).toBeCloseTo(0.4, 12);
    expect(e[1]).toBeCloseTo(-0.7, 12);
    expect(e[2]).toBeCloseTo(2.5, 12);
  });
});
