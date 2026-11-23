/**
 * Aircraft data for the flight model: mass properties, geometry and non-dimensional
 * aerodynamic derivatives (per radian).
 *
 * LIGHT_AIRCRAFT is a Cessna 172-class single-engine airplane. The numbers are typical
 * textbook values for that class, not data for any specific airframe, and the model has
 * not been compared with flight test data. It is good enough to give believable motion
 * (and to exercise trim, linearisation and cueing), not to train pilots.
 *
 * Control sign conventions used throughout this package (chosen so a pilot's input and
 * the surface share a sign):
 *   elevator  δe > 0 → nose up        aileron δa > 0 → roll right
 *   rudder    δr > 0 → nose right     throttle 0..1
 */
export interface Aircraft {
  name: string;
  /** kg */
  mass: number;
  /** Principal moments of inertia about body x, y, z (kg·m²); products of inertia ignored. */
  Ixx: number;
  Iyy: number;
  Izz: number;
  /** Wing area m², span m, mean aerodynamic chord m. */
  S: number;
  b: number;
  c: number;
  /** Maximum static thrust (N) and shaft power × propeller efficiency (W). */
  thrustStatic: number;
  powerEff: number;

  // Lift
  CL0: number;
  CLa: number;
  CLq: number;
  CLde: number;
  /** Angle of attack where lift peaks (rad); lift falls off past it. */
  alphaStall: number;
  // Drag: CD = CD0 + k·CL²
  CD0: number;
  k: number;
  // Side force
  CYb: number;
  CYdr: number;
  // Pitching moment
  Cm0: number;
  Cma: number;
  Cmq: number;
  Cmde: number;
  // Rolling moment
  Clb: number;
  Clp: number;
  Clr: number;
  Clda: number;
  Cldr: number;
  // Yawing moment
  Cnb: number;
  Cnp: number;
  Cnr: number;
  Cnda: number;
  Cndr: number;

  /** Control surface travel limits (rad). */
  deMax: number;
  daMax: number;
  drMax: number;
  /** Actuator rate limits: surfaces (rad/s) and throttle (per second). */
  surfaceRate: number;
  throttleRate: number;
  /** Pilot's head relative to the centre of gravity, body axes (x fwd, y right, z down), m. */
  pilot: readonly [number, number, number];
}

const DEG = Math.PI / 180;

export const LIGHT_AIRCRAFT: Aircraft = {
  name: "Light single (Cessna 172-class)",
  mass: 1043,
  Ixx: 1285,
  Iyy: 1825,
  Izz: 2667,
  S: 16.2,
  b: 11.0,
  c: 1.49,
  thrustStatic: 2400,
  powerEff: 0.75 * 119e3,

  CL0: 0.31,
  CLa: 5.143,
  CLq: 3.9,
  CLde: -0.43,
  alphaStall: 16 * DEG,
  CD0: 0.031,
  k: 0.054,
  CYb: -0.31,
  CYdr: -0.187,
  Cm0: -0.015,
  Cma: -0.89,
  Cmq: -12.4,
  Cmde: 1.28,
  Clb: -0.089,
  Clp: -0.47,
  Clr: 0.096,
  Clda: 0.178,
  Cldr: -0.0147,
  Cnb: 0.065,
  Cnp: -0.03,
  Cnr: -0.099,
  Cnda: -0.012,
  Cndr: 0.0657,

  deMax: 25 * DEG,
  daMax: 20 * DEG,
  drMax: 25 * DEG,
  surfaceRate: 60 * DEG,
  throttleRate: 0.5,
  pilot: [0.6, -0.3, -0.6],
};
