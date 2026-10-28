import type { Geometry, Limits } from "@stewart/kinematics";
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
}

export interface RigConfig {
  name: string;
  /** False until every value comes from a measurement of the real parts. */
  measured: boolean;
  notes?: string;
  geometry: Geometry;
  limits: Limits;
  servos: ServoCal[];
}

export class RigConfigError extends Error {}

const GEOMETRY_KEYS: (keyof Geometry)[] = [
  "baseRadius", "platformRadius", "baseHalfAngleDeg", "platformHalfAngleDeg", "hornLength", "rodLength",
];
const LIMIT_KEYS: (keyof Limits)[] = ["servoMinDeg", "servoMaxDeg", "ballSwivelDeg"];

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

  const servos = raw.servos;
  if (!Array.isArray(servos) || servos.length !== 6) errs.push("servos must list exactly 6 servos");
  else {
    const channels = new Set<number>();
    servos.forEach((sv: unknown, i) => {
      if (!isObj(sv)) return errs.push(`servos[${i}] must be an object`);
      if (!Number.isInteger(sv.channel) || (sv.channel as number) < 0 || (sv.channel as number) > 15)
        errs.push(`servos[${i}].channel must be an integer 0..15`);
      else if (channels.has(sv.channel as number)) errs.push(`servos[${i}].channel ${sv.channel} is used twice`);
      else channels.add(sv.channel as number);
      if (sv.direction !== 1 && sv.direction !== -1) errs.push(`servos[${i}].direction must be 1 or -1`);
      for (const k of ["trimUs", "centerUs", "usPerDeg"]) if (!isNum(sv[k])) errs.push(`servos[${i}].${k} must be a number`);
    });
  }

  if (errs.length) throw new RigConfigError(`Invalid rig config:\n- ${errs.join("\n- ")}`);
  return raw as unknown as RigConfig;
}

/** The config checked into the repo. */
export const defaultRig: RigConfig = parseRigConfig(defaultRigJson);
