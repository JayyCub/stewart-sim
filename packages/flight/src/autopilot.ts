/**
 * A small classical autopilot, used to fly the scripted manoeuvres repeatably:
 *  - bank-angle hold on the ailerons (proportional on bank, damping on roll rate),
 *  - turn coordination on the rudder (drives sideslip to zero, damps yaw rate about the
 *    steady-turn value),
 *  - altitude hold: an outer loop sets a pitch attitude, an inner PI loop on pitch with
 *    pitch-rate damping moves the elevator,
 *  - optional airspeed hold on the throttle (PI).
 * Everything is a deviation from the trim controls.
 */
import type { Aircraft } from "./aircraft.ts";
import { G0, clampControls, climbRate, type AirData, type Controls, type State } from "./dynamics.ts";
import { eulerFromQuat } from "./math.ts";
import type { Trim } from "./trim.ts";

export interface ApTarget {
  /** Bank angle, rad (positive = right wing down). */
  bank: number;
  /** Altitude to hold, m. */
  alt: number;
  /** Airspeed to hold, m/s; omit to leave the throttle where `throttle` puts it. */
  speed?: number;
  /** Throttle to use when not holding speed (default: trim). */
  throttle?: number;
}

export const AP_GAINS = {
  bank: 1.2, rollRate: 0.15,
  beta: 1.5, yawRate: 0.4,
  alt: 0.006, climb: 0.03, pitchMax: 0.2,
  pitch: 2.0, pitchRate: 0.6, pitchI: 1.0,
  speed: 0.08, speedI: 0.02,
} as const;

export class Autopilot {
  private pitchInt = 0;
  private speedInt = 0;

  reset(): void {
    this.pitchInt = 0;
    this.speedInt = 0;
  }

  controls(ac: Aircraft, trim: Trim, s: State, air: AirData, tgt: ApTarget, dt: number): Controls {
    const k = AP_GAINS;
    const [phi, theta] = eulerFromQuat(s.q);
    const [p, q, r] = s.w;
    const da = k.bank * (tgt.bank - phi) - k.rollRate * p;
    const rTurn = (G0 * Math.sin(phi)) / Math.max(air.Va, 10);
    const dr = k.beta * air.beta - k.yawRate * (r - rTurn);
    const thetaCmd = trim.alpha + Math.max(-k.pitchMax, Math.min(k.pitchMax, k.alt * (tgt.alt - -s.pos[2]) - k.climb * climbRate(s)));
    const eTheta = thetaCmd - theta;
    this.pitchInt = Math.max(-0.3, Math.min(0.3, this.pitchInt + eTheta * dt));
    const de = trim.controls.de + k.pitch * eTheta + k.pitchI * this.pitchInt - k.pitchRate * q;
    let throttle = tgt.throttle ?? trim.controls.throttle;
    if (tgt.speed !== undefined) {
      const eV = tgt.speed - air.Va;
      this.speedInt = Math.max(-10, Math.min(10, this.speedInt + eV * dt));
      throttle = trim.controls.throttle + k.speed * eV + k.speedI * this.speedInt;
    }
    return clampControls(ac, { de, da, dr, throttle });
  }
}
