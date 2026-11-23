/**
 * Rigid-body 6-DOF flight dynamics.
 *
 * Frames: NED for position (z down, so altitude = −pos[2]); body axes x forward, y right,
 * z down. Attitude is a body → NED quaternion, so there is no gimbal lock. Flat, non-rotating
 * Earth, constant gravity, ISA density. Forces: aerodynamics (linear derivatives with a
 * simple stall), propeller thrust along body x, gravity.
 *
 *   v̇ = F/m − ω × v           ω̇ = I⁻¹(M − ω × Iω)
 *   q̇ = ½ q ⊗ (0, ω)           ṗ = R(q) v
 */
import type { Aircraft } from "./aircraft.ts";
import { add3, cross, norm3, qmul, qnormalize, qrotate, qrotateInv, scale3, sub3, type Quat, type V3 } from "./math.ts";

export const G0 = 9.80665;

export interface State {
  /** Position in NED, m. Altitude is −pos[2]. */
  pos: V3;
  /** Velocity relative to the ground in body axes (u, v, w), m/s. */
  vel: V3;
  /** Attitude, body → NED. */
  q: Quat;
  /** Body angular rate (p, q, r), rad/s. */
  w: V3;
}

export interface Controls {
  /** Elevator, rad; positive = nose up. */
  de: number;
  /** Aileron, rad; positive = roll right. */
  da: number;
  /** Rudder, rad; positive = nose right. */
  dr: number;
  /** 0..1 */
  throttle: number;
}

export interface Derivative {
  pos: V3;
  vel: V3;
  q: Quat;
  w: V3;
}

/** Quantities worth showing or feeding to motion cueing, computed alongside the derivative. */
export interface AirData {
  /** Airspeed, m/s. */
  Va: number;
  /** Angle of attack and sideslip, rad. */
  alpha: number;
  beta: number;
  /** Specific force at the centre of gravity, body axes (what an accelerometer there reads), m/s². */
  f: V3;
  /** Angular acceleration, body axes, rad/s². */
  wdot: V3;
}

/** ISA troposphere density, kg/m³. */
export function density(alt: number): number {
  return 1.225 * Math.pow(Math.max(0, 1 - 2.25577e-5 * Math.min(alt, 11000)), 4.25588);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function clampControls(ac: Aircraft, u: Controls): Controls {
  return {
    de: clamp(u.de, -ac.deMax, ac.deMax),
    da: clamp(u.da, -ac.daMax, ac.daMax),
    dr: clamp(u.dr, -ac.drMax, ac.drMax),
    throttle: clamp(u.throttle, 0, 1),
  };
}

/**
 * Actuator model: each control moves toward its command no faster than its rate limit.
 * Real surfaces and engines can't jump, and without this an autopilot or a keyboard tap
 * produces angular-acceleration spikes no aircraft could.
 */
export function actuate(ac: Aircraft, current: Controls, command: Controls, dt: number): Controls {
  const c = clampControls(ac, command);
  const move = (from: number, to: number, rate: number) => from + clamp(to - from, -rate * dt, rate * dt);
  return {
    de: move(current.de, c.de, ac.surfaceRate),
    da: move(current.da, c.da, ac.surfaceRate),
    dr: move(current.dr, c.dr, ac.surfaceRate),
    throttle: move(current.throttle, c.throttle, ac.throttleRate),
  };
}

/** Lift coefficient from angle of attack alone: linear up to the stall, then falling off. */
function liftCurve(ac: Aircraft, alpha: number): number {
  const a = Math.abs(alpha);
  if (a <= ac.alphaStall) return ac.CL0 + ac.CLa * alpha;
  const peak = ac.CL0 + ac.CLa * ac.alphaStall * Math.sign(alpha);
  return peak * Math.max(0.6, 1 - 2 * (a - ac.alphaStall));
}

/**
 * Time derivative of the state.
 * @param gust wind velocity in body axes, m/s (turbulence); the air moves, so airspeed is vel − gust.
 */
export function derivative(ac: Aircraft, s: State, u: Controls, gust: V3 = [0, 0, 0]): { d: Derivative; air: AirData } {
  const [p, q, r] = s.w;
  const air = sub3(s.vel, gust);
  const Va = Math.max(norm3(air), 1e-3);
  const alpha = Math.atan2(air[2], air[0]);
  const beta = Math.asin(clamp(air[1] / Va, -1, 1));
  const qbar = 0.5 * density(-s.pos[2]) * Va * Va;
  const ph = (p * ac.b) / (2 * Va), qh = (q * ac.c) / (2 * Va), rh = (r * ac.b) / (2 * Va);

  const CL = liftCurve(ac, alpha) + ac.CLq * qh + ac.CLde * u.de;
  const stallDrag = Math.max(0, Math.abs(alpha) - ac.alphaStall);
  const CD = ac.CD0 + ac.k * CL * CL + stallDrag;
  const CY = ac.CYb * beta + ac.CYdr * u.dr;
  const Cl = ac.Clb * beta + ac.Clp * ph + ac.Clr * rh + ac.Clda * u.da + ac.Cldr * u.dr;
  const Cm = ac.Cm0 + ac.Cma * alpha + ac.Cmq * qh + ac.Cmde * u.de;
  const Cn = ac.Cnb * beta + ac.Cnp * ph + ac.Cnr * rh + ac.Cnda * u.da + ac.Cndr * u.dr;

  // Lift and drag act in the wind axes; rotate by alpha into body axes.
  const ca = Math.cos(alpha), sa = Math.sin(alpha);
  const L = qbar * ac.S * CL, D = qbar * ac.S * CD;
  const thrust = u.throttle * Math.min(ac.thrustStatic, ac.powerEff / Va);
  const Faero: V3 = [-D * ca + L * sa + thrust, qbar * ac.S * CY, -D * sa - L * ca];
  const M: V3 = [qbar * ac.S * ac.b * Cl, qbar * ac.S * ac.c * Cm, qbar * ac.S * ac.b * Cn];

  const f = scale3(Faero, 1 / ac.mass);
  const gBody = qrotateInv(s.q, [0, 0, G0]);
  const vdot = sub3(add3(f, gBody), cross(s.w, s.vel));
  const Iw: V3 = [ac.Ixx * p, ac.Iyy * q, ac.Izz * r];
  const tau = sub3(M, cross(s.w, Iw));
  const wdot: V3 = [tau[0] / ac.Ixx, tau[1] / ac.Iyy, tau[2] / ac.Izz];
  const qd = qmul(s.q, [0, p, q, r]);

  return {
    d: { pos: qrotate(s.q, s.vel), vel: vdot, q: [qd[0] / 2, qd[1] / 2, qd[2] / 2, qd[3] / 2], w: wdot },
    air: { Va, alpha, beta, f, wdot },
  };
}

function advance(s: State, d: Derivative, h: number): State {
  return {
    pos: add3(s.pos, scale3(d.pos, h)),
    vel: add3(s.vel, scale3(d.vel, h)),
    q: [s.q[0] + d.q[0] * h, s.q[1] + d.q[1] * h, s.q[2] + d.q[2] * h, s.q[3] + d.q[3] * h],
    w: add3(s.w, scale3(d.w, h)),
  };
}

/** One classical 4th-order Runge–Kutta step of length h, controls and gust held over the step. */
export function step(ac: Aircraft, s: State, u: Controls, h: number, gust: V3 = [0, 0, 0]): State {
  const k1 = derivative(ac, s, u, gust).d;
  const k2 = derivative(ac, advance(s, k1, h / 2), u, gust).d;
  const k3 = derivative(ac, advance(s, k2, h / 2), u, gust).d;
  const k4 = derivative(ac, advance(s, k3, h), u, gust).d;
  const comb = (a: number, b: number, c: number, e: number) => (a + 2 * b + 2 * c + e) / 6;
  const n = advance(s, {
    pos: [0, 1, 2].map((i) => comb(k1.pos[i]!, k2.pos[i]!, k3.pos[i]!, k4.pos[i]!)) as unknown as V3,
    vel: [0, 1, 2].map((i) => comb(k1.vel[i]!, k2.vel[i]!, k3.vel[i]!, k4.vel[i]!)) as unknown as V3,
    q: [0, 1, 2, 3].map((i) => comb(k1.q[i]!, k2.q[i]!, k3.q[i]!, k4.q[i]!)) as unknown as Quat,
    w: [0, 1, 2].map((i) => comb(k1.w[i]!, k2.w[i]!, k3.w[i]!, k4.w[i]!)) as unknown as V3,
  }, h);
  return { ...n, q: qnormalize(n.q) };
}

/** Specific force at a point r (body axes, from the CG) on the rigid body: f + ω̇×r + ω×(ω×r). */
export function specificForceAt(air: AirData, w: V3, r: V3): V3 {
  return add3(air.f, add3(cross(air.wdot, r), cross(w, cross(w, r))));
}

/** Rotational kinetic energy ½ωᵀIω (used to check the integrator). */
export function rotationalEnergy(ac: Aircraft, w: V3): number {
  return 0.5 * (ac.Ixx * w[0] ** 2 + ac.Iyy * w[1] ** 2 + ac.Izz * w[2] ** 2);
}

/** Angular momentum in NED (constant when no torque acts). */
export function angularMomentumNed(ac: Aircraft, s: State): V3 {
  return qrotate(s.q, [ac.Ixx * s.w[0], ac.Iyy * s.w[1], ac.Izz * s.w[2]]);
}

export const altitude = (s: State): number => -s.pos[2];
/** Ground speed, m/s. */
export const speed = (s: State): number => norm3(s.vel);
/** Climb rate, m/s (positive up). */
export const climbRate = (s: State): number => -qrotate(s.q, s.vel)[2];
