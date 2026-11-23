/**
 * Classical washout motion cueing (after Reid & Nahon), sized for a small Stewart platform.
 *
 * The rider senses specific force (what an accelerometer reads) and angular rate. A platform
 * with a few centimetres of travel cannot reproduce sustained acceleration, so the cue is split:
 *
 *  - Translational channel: specific force, high-passed (3rd order), double-integrated to
 *    platform position. Onsets get a real push; the platform then drifts back to centre.
 *  - Tilt coordination: the low-frequency part of surge/sway specific force is reproduced by
 *    tilting the platform so gravity leans on the rider. The tilt is rate-limited below what a
 *    rider notices (≈3°/s), so it reads as acceleration, not rotation.
 *  - Rotational channel: angular rate, high-passed (2nd order) and integrated to angle. Roll
 *    and pitch onsets are felt, then washed out.
 *
 * Inputs are in aircraft body axes (x fwd, y right, z down); output is a platform Pose in the
 * rig's frame (x front, y left, z up; mm and rad). Converting between the two flips y and z,
 * so roll keeps its sign while pitch and yaw change sign.
 *
 * The output is not limit-checked here: the caller must pass it through the rig's IK checks
 * (limitPose in @stewart/kinematics) before it goes anywhere.
 */
import { G0 } from "./dynamics.ts";
import type { V3 } from "./math.ts";

export interface WashoutParams {
  /** Scale on surge/sway specific force fed to the translational channel. */
  transGain: number;
  /** Scale on vertical specific force fed to heave (small rigs have little heave travel). */
  heaveGain: number;
  /** Translational high-pass: 2nd-order natural frequency (rad/s) and damping, plus a 1st-order break (rad/s). */
  transWn: number;
  transZeta: number;
  transWb: number;
  /** Scale on specific force fed to tilt coordination. */
  tiltGain: number;
  /** Tilt low-pass natural frequency (rad/s), damping 1. */
  tiltWn: number;
  /** Tilt rate limit (rad/s) and largest tilt (rad). */
  tiltRateMax: number;
  tiltMax: number;
  /** Scale on angular rate fed to the rotational channel. */
  rotGain: number;
  /** Rotational high-pass natural frequency (rad/s), damping 1. */
  rotWn: number;
}

const DEG = Math.PI / 180;

export const DEFAULT_WASHOUT: WashoutParams = {
  transGain: 0.3,
  heaveGain: 0.1,
  transWn: 4,
  transZeta: 1,
  transWb: 1,
  tiltGain: 0.6,
  tiltWn: 2,
  tiltRateMax: 3 * DEG,
  tiltMax: 8 * DEG,
  rotGain: 1.0,
  rotWn: 1.5,
};

/**
 * Single-input single-output linear filter num(s)/den(s), den monic, deg num ≤ deg den,
 * in controllable canonical form, stepped with RK4 holding the input over the step.
 */
export class TransferFunction {
  private readonly a: number[];
  private readonly c: number[];
  private readonly d: number;
  x: number[];

  /** Coefficients highest power first; den[0] must be 1. */
  constructor(num: number[], den: number[]) {
    const n = den.length - 1;
    if (den[0] !== 1) throw new Error("den must be monic");
    const nm = [...new Array<number>(n + 1 - num.length).fill(0), ...num];
    this.d = nm[0]!;
    const b = nm.map((v, i) => v - this.d * den[i]!); // strictly proper remainder
    this.a = den.slice(1); // a1..an
    this.c = Array.from({ length: n }, (_, i) => b[n - i]!); // c_i multiplies x_{i+1}
    this.x = new Array<number>(n).fill(0);
  }

  private deriv(x: number[], u: number): number[] {
    const n = x.length;
    const dx = x.slice(1);
    let last = u;
    for (let i = 0; i < n; i++) last -= this.a[n - 1 - i]! * x[i]!;
    dx.push(last);
    return dx;
  }

  output(u = 0): number {
    return this.x.reduce((s, xi, i) => s + this.c[i]! * xi, 0) + this.d * u;
  }

  step(u: number, dt: number): number {
    const x = this.x;
    const k1 = this.deriv(x, u);
    const k2 = this.deriv(x.map((v, i) => v + (dt / 2) * k1[i]!), u);
    const k3 = this.deriv(x.map((v, i) => v + (dt / 2) * k2[i]!), u);
    const k4 = this.deriv(x.map((v, i) => v + dt * k3[i]!), u);
    this.x = x.map((v, i) => v + (dt / 6) * (k1[i]! + 2 * k2[i]! + 2 * k3[i]! + k4[i]!));
    return this.output(u);
  }

  reset(): void {
    this.x.fill(0);
  }
}

/** Position per unit acceleration: s / ((s² + 2ζωs + ω²)(s + ωb)) — a 3rd-order high-pass, integrated twice. */
const transFilter = (p: WashoutParams) =>
  new TransferFunction([1, 0], [1, 2 * p.transZeta * p.transWn + p.transWb, p.transWn ** 2 + 2 * p.transZeta * p.transWn * p.transWb, p.transWn ** 2 * p.transWb]);
/** Angle per unit rate: s / (s² + 2ω s + ω²) — a 2nd-order high-pass, integrated once. */
const rotFilter = (p: WashoutParams) => new TransferFunction([1, 0], [1, 2 * p.rotWn, p.rotWn ** 2]);
/** Unity-gain 2nd-order low-pass, damping 1. */
const lowPass = (p: WashoutParams) => new TransferFunction([p.tiltWn ** 2], [1, 2 * p.tiltWn, p.tiltWn ** 2]);

export interface CuePose {
  x: number;
  y: number;
  z: number;
  roll: number;
  pitch: number;
  yaw: number;
}

/** Aircraft body axes → rig axes (x front, y left, z up). */
export const bodyToRig = (v: V3): V3 => [v[0], -v[1], -v[2]];

export class Washout {
  params: WashoutParams;
  private trans: TransferFunction[] = [];
  private rot: TransferFunction[] = [];
  private tiltLp: TransferFunction[] = [];
  /** Current tilt-coordination angles (roll, pitch), rad, after the rate limit. */
  tilt: [number, number] = [0, 0];

  constructor(params: WashoutParams = DEFAULT_WASHOUT) {
    this.params = { ...params };
    this.rebuild();
  }

  /** Change parameters; filter states restart from rest. */
  setParams(params: WashoutParams): void {
    this.params = { ...params };
    this.rebuild();
  }

  private rebuild(): void {
    const p = this.params;
    this.trans = [transFilter(p), transFilter(p), transFilter(p)];
    this.rot = [rotFilter(p), rotFilter(p), rotFilter(p)];
    this.tiltLp = [lowPass(p), lowPass(p)];
    this.tilt = [0, 0];
  }

  reset(): void {
    this.rebuild();
  }

  /**
   * Advance by dt with the rider's specific force f and angular rate w, both in aircraft
   * body axes. Returns the platform pose (mm, rad) in the rig frame.
   */
  step(f: V3, w: V3, dt: number): CuePose {
    const p = this.params;
    const fr = bodyToRig(f);
    const wr = bodyToRig(w);
    // Remove 1 g so straight-and-level flight is the neutral platform pose.
    const a: V3 = [fr[0], fr[1], fr[2] - G0];
    const gains = [p.transGain, p.transGain, p.heaveGain];
    const pos = [0, 1, 2].map((i) => this.trans[i]!.step(gains[i]! * a[i]!, dt) * 1000);

    // Tilt so gravity in the platform frame matches the low-passed surge/sway force:
    // in the platform frame gravity gives f_x = −g·sin(pitch), f_y = g·sin(roll).
    const s = Math.sin(p.tiltMax);
    const fxLp = this.tiltLp[0]!.step(p.tiltGain * a[0], dt);
    const fyLp = this.tiltLp[1]!.step(p.tiltGain * a[1], dt);
    const target: [number, number] = [
      Math.asin(Math.max(-s, Math.min(s, fyLp / G0))),
      -Math.asin(Math.max(-s, Math.min(s, fxLp / G0))),
    ];
    const maxStep = p.tiltRateMax * dt;
    this.tilt = [0, 1].map((i) => this.tilt[i]! + Math.max(-maxStep, Math.min(maxStep, target[i]! - this.tilt[i]!))) as [number, number];

    const ang = [0, 1, 2].map((i) => this.rot[i]!.step(p.rotGain * wr[i]!, dt));
    return { x: pos[0]!, y: pos[1]!, z: pos[2]!, roll: ang[0]! + this.tilt[0], pitch: ang[1]! + this.tilt[1], yaw: ang[2]! };
  }
}

/**
 * What a rider on the platform actually feels, from the platform's own motion: specific force
 * f = Rᵀ(a + g·ẑ) and angular rate, rig frame. Differentiates the pose stream, so feed it
 * the pose the platform really reaches (after limiting), once per fixed step.
 */
export class CueMeter {
  private hist: CuePose[] = [];
  f: V3 = [0, 0, G0];
  w: V3 = [0, 0, 0];

  push(p: CuePose, dt: number): void {
    this.hist.push(p);
    if (this.hist.length > 3) this.hist.shift();
    if (this.hist.length < 3) return;
    const [p0, p1, p2] = this.hist as [CuePose, CuePose, CuePose];
    const acc: V3 = [
      ((p2.x - 2 * p1.x + p0.x) / 1000) / (dt * dt),
      ((p2.y - 2 * p1.y + p0.y) / 1000) / (dt * dt),
      ((p2.z - 2 * p1.z + p0.z) / 1000) / (dt * dt) + G0,
    ];
    // Rᵀ·v for R = Rz(yaw)·Ry(pitch)·Rx(roll) (the rig's convention).
    const cr = Math.cos(p2.roll), sr = Math.sin(p2.roll), cp = Math.cos(p2.pitch), sp = Math.sin(p2.pitch);
    const cy = Math.cos(p2.yaw), sy = Math.sin(p2.yaw);
    const R = [
      cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr,
      sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr,
      -sp, cp * sr, cp * cr,
    ];
    this.f = [
      R[0]! * acc[0] + R[3]! * acc[1] + R[6]! * acc[2],
      R[1]! * acc[0] + R[4]! * acc[1] + R[7]! * acc[2],
      R[2]! * acc[0] + R[5]! * acc[1] + R[8]! * acc[2],
    ];
    // Small-angle body rates from Euler-angle rates.
    this.w = [(p2.roll - p1.roll) / dt, (p2.pitch - p1.pitch) / dt, (p2.yaw - p1.yaw) / dt];
  }

  reset(): void {
    this.hist = [];
    this.f = [0, 0, G0];
    this.w = [0, 0, 0];
  }
}
