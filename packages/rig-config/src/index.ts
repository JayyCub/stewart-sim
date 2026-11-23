import { DEFAULT_COLLISION, type Collision, type Geometry, type Limits } from "@stewart/kinematics";
import defaultRigJson from "../rig.json" with { type: "json" };

/** Per-servo calibration. Firmware maps horn angle to pulse width with these. */
export interface ServoCal {
  /** PCA9685 output channel, 0..15. */
  channel: number;
  /** +1 if a larger pulse raises the horn, -1 if the servo is mirrored. */
  direction: 1 | -1;
  /** Offset that makes the horn level at alpha = 0, microseconds. */
  trimUs: number;
  /** Nominal centre pulse, microseconds. */
  centerUs: number;
  /** Pulse change per degree of horn travel, microseconds. */
  usPerDeg: number;
  /**
   * Number written on this servo, 1..6, used by the UI and bench scripts. Optional;
   * defaults to leg index + 1. Lets the physical numbering differ from the leg order
   * the kinematics needs (legs run counter-clockwise seen from above).
   */
  label?: number;
}

/** The servo's label (number written on it), defaulting to leg index + 1. */
export const servoLabel = (rig: Pick<RigConfig, "servos">, leg: number): number => rig.servos[leg]?.label ?? leg + 1;

/** Hardware motion limits used by the bench scripts and (later) firmware. Optional in the file. */
export interface MotionLimits {
  /** Fastest the host may command any horn to move, degrees per second. */
  maxHornDegPerSec: number;
}

export interface RigConfig {
  name: string;
  /** False until every value comes from a measurement of the real parts. */
  measured: boolean;
  notes?: string;
  geometry: Geometry;
  limits: Limits;
  /** Part sizes for collision checks. Optional in the file; missing values take the MG996R defaults. */
  collision: Collision;
  motion?: MotionLimits;
  servos: ServoCal[];
}

export class RigConfigError extends Error {}

const GEOMETRY_KEYS: (keyof Geometry)[] = [
  "baseRadius", "platformRadius", "baseHalfAngleDeg", "platformHalfAngleDeg", "hornLength", "rodLength",
];
const LIMIT_KEYS: (keyof Limits)[] = ["servoMinDeg", "servoMaxDeg", "ballSwivelDeg"];
const COLLISION_KEYS = Object.keys(DEFAULT_COLLISION) as (keyof Collision)[];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Validate an untrusted value (parsed JSON) as a RigConfig. Throws RigConfigError listing every problem. */
export function parseRigConfig(raw: unknown): RigConfig {
  const errs: string[] = [];
  if (!isObj(raw)) throw new RigConfigError("rig config must be a JSON object");

  if (typeof raw.name !== "string") errs.push("name must be a string");
  if (typeof raw.measured !== "boolean") errs.push("measured must be true or false");

  const geo = raw.geometry;
  if (!isObj(geo)) errs.push("geometry must be an object");
  else {
    for (const k of GEOMETRY_KEYS) if (!isNum(geo[k]) || (geo[k] as number) <= 0) errs.push(`geometry.${k} must be a positive number`);
    if (isNum(geo.baseHalfAngleDeg) && geo.baseHalfAngleDeg >= 60) errs.push("geometry.baseHalfAngleDeg must be under 60");
    if (isNum(geo.platformHalfAngleDeg) && geo.platformHalfAngleDeg >= 60) errs.push("geometry.platformHalfAngleDeg must be under 60");
    // Optional mount orientation; omitted means 0 (radial, level shafts and studs).
    for (const [k, max] of [["servoYawDeg", 60], ["servoTiltDeg", 75], ["topStudTiltDeg", 75], ["frontDeg", 180]] as const) {
      if (geo[k] === undefined) continue;
      if (!isNum(geo[k]) || Math.abs(geo[k] as number) > max) errs.push(`geometry.${k} must be a number from -${max} to ${max}`);
    }
  }

  const lim = raw.limits;
  if (!isObj(lim)) errs.push("limits must be an object");
  else {
    for (const k of LIMIT_KEYS) if (!isNum(lim[k])) errs.push(`limits.${k} must be a number`);
    if (isNum(lim.servoMinDeg) && isNum(lim.servoMaxDeg) && lim.servoMinDeg >= lim.servoMaxDeg)
      errs.push("limits.servoMinDeg must be below servoMaxDeg");
    if (isNum(lim.ballSwivelDeg) && (lim.ballSwivelDeg <= 0 || lim.ballSwivelDeg >= 90))
      errs.push("limits.ballSwivelDeg must be between 0 and 90");
  }

  let collision: Collision = { ...DEFAULT_COLLISION };
  if (raw.collision !== undefined) {
    const col = raw.collision;
    if (!isObj(col)) errs.push("collision must be an object");
    else {
      for (const k of COLLISION_KEYS) {
        if (col[k] === undefined) continue;
        if (!isNum(col[k])) errs.push(`collision.${k} must be a number`);
        else collision[k] = col[k] as number;
      }
      for (const k of ["servoLength", "servoWidth", "servoDepth", "rodRadius"] as const)
        if (isNum(col[k]) && (col[k] as number) <= 0) errs.push(`collision.${k} must be positive`);
      for (const k of ["servoInset", "minClearance"] as const)
        if (isNum(col[k]) && (col[k] as number) < 0) errs.push(`collision.${k} must not be negative`);
      if (isNum(col.hornRodMinDeg) && (col.hornRodMinDeg < 0 || col.hornRodMinDeg >= 180))
        errs.push("collision.hornRodMinDeg must be between 0 and 180");
      if (isNum(col.shaftFromSide) && (col.shaftFromSide as number) < 0) errs.push("collision.shaftFromSide must not be negative");
    }
  }

  if (raw.motion !== undefined) {
    const mo = raw.motion;
    if (!isObj(mo)) errs.push("motion must be an object");
    else if (!isNum(mo.maxHornDegPerSec) || mo.maxHornDegPerSec <= 0)
      errs.push("motion.maxHornDegPerSec must be a positive number");
  }

  const servos = raw.servos;
  if (!Array.isArray(servos) || servos.length !== 6) errs.push("servos must list exactly 6 servos");
  else {
    const channels = new Set<number>();
    const labels = new Set<number>();
    servos.forEach((sv: unknown, i) => {
      if (!isObj(sv)) return errs.push(`servos[${i}] must be an object`);
      if (!Number.isInteger(sv.channel) || (sv.channel as number) < 0 || (sv.channel as number) > 15)
        errs.push(`servos[${i}].channel must be an integer 0..15`);
      else if (channels.has(sv.channel as number)) errs.push(`servos[${i}].channel ${sv.channel} is used twice`);
      else channels.add(sv.channel as number);
      if (sv.direction !== 1 && sv.direction !== -1) errs.push(`servos[${i}].direction must be 1 or -1`);
      for (const k of ["trimUs", "centerUs", "usPerDeg"]) if (!isNum(sv[k])) errs.push(`servos[${i}].${k} must be a number`);
      const label = sv.label ?? i + 1;
      if (!Number.isInteger(label) || (label as number) < 1 || (label as number) > 6) errs.push(`servos[${i}].label must be an integer 1..6`);
      else if (labels.has(label as number)) errs.push(`servos[${i}].label ${label} is used twice`);
      else labels.add(label as number);
    });
  }

  if (errs.length) throw new RigConfigError(`Invalid rig config:\n- ${errs.join("\n- ")}`);
  return { ...(raw as unknown as RigConfig), collision };
}

/** Parse rig.json text (from a file or a paste). Throws RigConfigError for bad JSON or a bad config. */
export function parseRigJson(text: string): RigConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new RigConfigError(`Not valid JSON: ${(e as Error).message}`);
  }
  return parseRigConfig(raw);
}

/** The config checked into the repo. */
export const defaultRig: RigConfig = parseRigConfig(defaultRigJson);

/**
 * Absolute pulse window enforced by firmware/servo_test (ABS_MIN_US / ABS_MAX_US there).
 * Hosts check it too, so a frame outside it is refused before it is sent.
 */
export const FIRMWARE_MIN_US = 500;
export const FIRMWARE_MAX_US = 2500;

/** Horn angle from level (degrees, + raises the horn) -> pulse width for that servo. Same as rig_serial.deg_to_us. */
export const degToUs = (servo: ServoCal, deg: number): number =>
  Math.round(servo.centerUs + servo.trimUs + servo.direction * servo.usPerDeg * deg);

/**
 * Horn angles in leg order -> pulse widths indexed by channel, for the firmware's six-channel
 * frames ("A" / "Q"). Throws RigConfigError if the servos are not on channels 0-5 or any pulse
 * falls outside the firmware window, so a bad frame is never built.
 */
export function frameUs(rig: Pick<RigConfig, "servos">, degs: readonly number[]): number[] {
  const us = new Array<number>(rig.servos.length).fill(0);
  const channels = rig.servos.map((s) => s.channel).sort((a, b) => a - b);
  if (channels.some((c, i) => c !== i)) throw new RigConfigError(`six-channel frames need servos on channels 0-5, rig has ${channels.join(", ")}`);
  if (degs.length !== rig.servos.length) throw new RigConfigError(`need ${rig.servos.length} horn angles, got ${degs.length}`);
  rig.servos.forEach((s, i) => {
    const d = degs[i]!;
    const u = degToUs(s, d);
    if (!(u >= FIRMWARE_MIN_US && u <= FIRMWARE_MAX_US))
      throw new RigConfigError(`${d.toFixed(1)}° is ${u} us on servo ${servoLabel(rig, i)}, outside the firmware window ${FIRMWARE_MIN_US}-${FIRMWARE_MAX_US} us`);
    us[s.channel] = u;
  });
  return us;
}
