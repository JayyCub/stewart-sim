/**
 * Units: millimetres for lengths, radians for angles in the kinematics API.
 * Rig config (human-edited JSON) stores angles in degrees; convert at the edge.
 *
 * Frames: z is up. The base frame origin is the centre of the base at the
 * height of the servo shafts. The platform frame origin is the centre of the
 * top plate at the height of the top ball joints.
 */

export type Vec3 = readonly [number, number, number];

/** Design parameters that set the shape of the platform. */
export interface Geometry {
  /** Base centre to each servo's horn pivot (shaft axis), mm. */
  baseRadius: number;
  /** Platform centre to each top ball joint, mm. */
  platformRadius: number;
  /** Half the angular spacing between the two servos of a pair, degrees. */
  baseHalfAngleDeg: number;
  /** Half the angular spacing between the two top joints of a pair, degrees. */
  platformHalfAngleDeg: number;
  /** Shaft centre to the horn hole the rod end is bolted to, mm. */
  hornLength: number;
  /** Ball centre to ball centre, mm. */
  rodLength: number;
}

/** Physical limits, ideally measured on the real parts. */
export interface Limits {
  /** Lowest horn angle from horizontal the servo can reach, degrees. */
  servoMinDeg: number;
  /** Highest horn angle from horizontal the servo can reach, degrees. */
  servoMaxDeg: number;
  /** Largest tilt of the rod away from perpendicular to the ball stud, degrees. */
  ballSwivelDeg: number;
}

/**
 * Platform pose relative to home. x, y, z in mm (z = 0 is home height).
 * roll about x, pitch about y, yaw about z, in radians, applied as
 * R = Rz(yaw) · Ry(pitch) · Rx(roll).
 */
export interface Pose {
  x: number;
  y: number;
  z: number;
  roll: number;
  pitch: number;
  yaw: number;
}

/** Fixed joint layout derived from Geometry. One entry per leg, legs 0..5. */
export interface Layout {
  /** Horn pivot points in the base frame (z = 0). */
  base: Vec3[];
  /** Top joint points in the platform frame (z = 0). */
  platform: Vec3[];
  /** Angle of each horn's plane in the xy plane: horn direction at alpha = 0 is (cos beta, sin beta, 0). */
  beta: number[];
  /** Unit vector along each servo shaft (radial), which is also the bottom ball stud axis. */
  shaftAxis: Vec3[];
  /** Unit vector along each top ball stud in the platform frame (radial). */
  topStudAxis: Vec3[];
  /** Height of the platform frame above the base frame at home pose (all horns level), mm. */
  homeHeight: number;
}

export type LegFault = "no-solution" | "servo-range" | "ball-swivel-bottom" | "ball-swivel-top";

export interface LegSolution {
  /** Horn angle from horizontal, radians. Positive raises the horn tip. NaN if unreachable. */
  alpha: number;
  /** Horn pivot, base frame. */
  pivot: Vec3;
  /** Horn tip (bottom ball centre), base frame. */
  hornTip: Vec3;
  /** Top ball centre, base frame. */
  top: Vec3;
  /** Rod tilt away from perpendicular to the bottom stud, radians. */
  swivelBottom: number;
  /** Rod tilt away from perpendicular to the top stud, radians. */
  swivelTop: number;
  faults: LegFault[];
}

export interface Solution {
  legs: LegSolution[];
  ok: boolean;
}
