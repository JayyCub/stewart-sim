/**
 * Limit finding: turn positions marked on the real rig into rig.json limits.
 *
 * On the bench you jog one servo at a time until something physically stops it, and mark that
 * position with what touched. Each mark stores the raw pulses on all six channels (what the
 * servos were really holding), so it stays valid if the calibration changes later.
 *
 * The fit re-runs the model at each marked configuration: forward kinematics gives the platform
 * pose those six horn angles produce, and the matching measurement (horn angle, ball swivel,
 * horn-rod angle, rod-to-servo gap) is the value the model's limit should have had to stop
 * right there. The most restrictive mark per limit, less a safety margin, becomes the
 * suggestion. "Horn is level" marks set each servo's trimUs, and are applied before anything
 * else so every angle is measured from the true level.
 *
 * "Clear" marks are the other half: the servo swept from level to the marked angle (the other
 * servos where the mark recorded them) and nothing touched. The fit re-runs the model along that
 * whole sweep, and any limit that would have stopped it is loosened just enough to allow it, with
 * no margin, since nothing was hit. A clear sweep never tightens anything.
 */
import { DEG, buildLayout, forward, hornRodAngle, rodBodyGap, solve, type LegFault, type Pose } from "@stewart/kinematics";
import { FIRMWARE_MAX_US, FIRMWARE_MIN_US, servoLabel, type RigConfig, type ServoCal } from "@stewart/rig-config";

export type MarkKind = "max" | "min" | "level" | "clear";

/** What physically stopped the horn, as seen on the bench. */
export type MarkCause = "horn-stop" | "rod-horn" | "rod-servo" | "ball-bottom" | "ball-top" | "binding" | "other";

export const CAUSE_LABEL: Record<MarkCause, string> = {
  "horn-stop": "Horn or servo hit a hard stop (servo body, plate, gear end stop)",
  "rod-horn": "Rod folded onto its own horn",
  "rod-servo": "Rod touched a servo body",
  "ball-bottom": "Lower ball joint at the end of its swivel",
  "ball-top": "Upper ball joint at the end of its swivel",
  binding: "Rig binds: servo strains, nothing visibly touching",
  other: "Something else (say what in the note)",
};

/** Short form for the log table. */
export const CAUSE_SHORT: Record<MarkCause, string> = {
  "horn-stop": "hard stop",
  "rod-horn": "rod on horn",
  "rod-servo": "rod on servo",
  "ball-bottom": "lower ball joint",
  "ball-top": "upper ball joint",
  binding: "binding",
  other: "other",
};

/** A mark this far from the current limit (degrees / mm) more likely means a wrong cause or wrong geometry than a wrong limit. */
export const SUSPECT_GAP = { deg: 10, mm: 3 };

export const FAULT_TEXT: Record<LegFault, string> = {
  "no-solution": "out of reach",
  "servo-range": "servo range",
  "ball-swivel-bottom": "lower ball joint",
  "ball-swivel-top": "upper ball joint",
  "servo-clash": "servo bodies clash",
  "rod-hits-servo": "rod hits a servo",
  "rod-hits-horn": "rod hits horn",
};

export interface LimitMark {
  id: string;
  /** ISO time the mark was taken. */
  time: string;
  /** rig.json name loaded when the mark was taken. */
  rigName: string;
  /** PCA9685 channel of the servo being jogged (stable even if the leg order changes). */
  channel: number;
  /** Number written on that servo, for reading the log. */
  label: number;
  kind: MarkKind;
  /** Required for max/min marks. */
  cause?: MarkCause;
  note?: string;
  /** Pulse on each channel 0-5 when the mark was taken: what the servos were holding. */
  usByChannel: number[];
}

export interface MarkLog {
  kind: "stewart-limit-marks";
  version: 1;
  marks: LimitMark[];
}

export type LimitParam = "servoMinDeg" | "servoMaxDeg" | "ballSwivelDeg" | "hornRodMinDeg" | "rodRadius";

interface ParamInfo {
  label: string;
  unit: "°" | "mm";
  /** "upper": the limit is a ceiling (contact value minus margin); "lower": a floor. */
  side: "upper" | "lower";
}

export const PARAMS: Record<LimitParam, ParamInfo> = {
  servoMaxDeg: { label: "Servo max (limits.servoMaxDeg)", unit: "°", side: "upper" },
  servoMinDeg: { label: "Servo min (limits.servoMinDeg)", unit: "°", side: "lower" },
  ballSwivelDeg: { label: "Ball swivel (limits.ballSwivelDeg)", unit: "°", side: "upper" },
  hornRodMinDeg: { label: "Horn-rod angle (collision.hornRodMinDeg)", unit: "°", side: "lower" },
  rodRadius: { label: "Rod radius (collision.rodRadius)", unit: "mm", side: "lower" },
};

export interface MarkResult {
  mark: LimitMark;
  /** Leg index of the jogged servo in the loaded rig; -1 if no servo is on that channel. */
  leg: number;
  /** Horn angles in leg order with the fitted trims, degrees. */
  alphaDeg: number[] | null;
  /** Pose the model gives for those horn angles; null if the model says they cannot be built. */
  pose: Pose | null;
  /** Model faults on each leg at that pose (current limits). */
  faults: LegFault[][] | null;
  /** The limit this mark measures and its value at the contact. */
  measure: { param: LimitParam; value: number } | null;
  /**
   * How far the current software limit lets the rig go past this contact, in the limit's units.
   * Positive: software allows motion into the obstacle (unsafe). Negative: software stops short.
   */
  overshoot: number | null;
  /** Why no measurement could be made, if none. */
  problem: string | null;
  /** For "clear" marks: what the model makes of the sweep from level to the mark. */
  sweep: ClearSweep | null;
}

export interface ClearSweep {
  /** What each limit must allow for the sweep to pass (horn range always; the rest where the model has a pose). */
  needs: { param: LimitParam; value: number }[];
  /** First angle from level where the current model would have stopped the servo, and why. */
  stoppedAt: { deg: number; why: string } | null;
  /** First angle on the sweep where the model has no pose; it cannot check the joints beyond it. */
  noPoseFrom: number | null;
}

export interface Suggestion {
  param: LimitParam;
  current: number;
  /** Most restrictive contact across the marks; for clear sweeps only, the furthest cleared value. */
  measured: number;
  source: "contact" | "clear" | "both";
  suggested: number;
  marks: number;
  /** Distinct servos the marks came from. */
  servos: number;
  change: "tighter" | "looser" | "same";
  warn: string | null;
}

export interface TrimSuggestion {
  leg: number;
  label: number;
  current: number;
  suggested: number;
}

export interface Fit {
  results: MarkResult[];
  suggestions: Suggestion[];
  trims: TrimSuggestion[];
  /** The loaded rig with every suggestion applied (unchanged when there are none). */
  rig: RigConfig;
}

export interface Margins {
  /** Kept between a measured contact and an angle limit, degrees. */
  deg: number;
  /** Added to the measured rod-to-servo gap, mm. */
  mm: number;
}

export const DEFAULT_MARGINS: Margins = { deg: 2, mm: 0.5 };

/** Pulse width -> horn angle from level, degrees (inverse of degToUs). */
export const usToDeg = (s: ServoCal, us: number): number => (us - s.centerUs - s.trimUs) / (s.direction * s.usPerDeg);

/**
 * Forward kinematics from home out to the target angles in small steps, each solve starting
 * from the last pose, so Newton stays on the branch the rig is really assembled in.
 */
export function forwardFromHome(rig: RigConfig, alphaDeg: readonly number[], layout = buildLayout(rig.geometry)): Pose | null {
  const steps = Math.max(1, Math.ceil(Math.max(...alphaDeg.map(Math.abs)) / 5));
  let pose: Pose | null = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };
  for (let k = 1; k <= steps && pose; k++) pose = forward(layout, rig.geometry, alphaDeg.map((d) => (d * DEG * k) / steps), pose);
  return pose;
}

/** Sweep step for clear marks, degrees. */
const SWEEP_STEP = 0.5;

/**
 * Re-run the model along a clear sweep: the jogged leg from 0° to its marked angle, the others
 * fixed. Returns what each limit must allow, and where the current limits would have stopped it.
 */
function clearSweep(rig: RigConfig, calRig: RigConfig, layout: ReturnType<typeof buildLayout>, alphaDeg: readonly number[], leg: number): ClearSweep {
  const end = alphaDeg[leg]!;
  const needs: ClearSweep["needs"] = [{ param: end >= 0 ? "servoMaxDeg" : "servoMinDeg", value: end }];
  const at = (deg: number) => alphaDeg.map((d, i) => (i === leg ? deg : d));
  const n = Math.max(1, Math.ceil(Math.abs(end) / SWEEP_STEP));
  let pose = forwardFromHome(calRig, at(0), layout);
  let hornRod = Infinity, gap = Infinity, swivel = -Infinity;
  let stoppedAt: ClearSweep["stoppedAt"] = null;
  let noPoseFrom: number | null = null;
  for (let k = 0; k <= n; k++) {
    const deg = (end * k) / n;
    if (k > 0 && pose) pose = forward(layout, rig.geometry, at(deg).map((d) => d * DEG), pose);
    if (!pose) {
      noPoseFrom = deg;
      stoppedAt ??= { deg, why: "the model has no pose" };
      break;
    }
    const sol = solve(layout, rig.geometry, rig.limits, pose, rig.collision);
    const l = sol.legs[leg]!;
    hornRod = Math.min(hornRod, hornRodAngle(l) / DEG);
    gap = Math.min(gap, rodBodyGap(layout, rig.collision, l));
    swivel = Math.max(swivel, l.swivelBottom / DEG, l.swivelTop / DEG);
    if (!stoppedAt && !sol.ok) {
      const bad = sol.legs.findIndex((x) => x.faults.length > 0);
      stoppedAt = { deg, why: `servo ${servoLabel(rig, bad)}: ${sol.legs[bad]!.faults.map((f) => FAULT_TEXT[f]).join(", ")}` };
    }
  }
  if (Number.isFinite(hornRod)) needs.push({ param: "hornRodMinDeg", value: hornRod }, { param: "rodRadius", value: gap }, { param: "ballSwivelDeg", value: swivel });
  return { needs, stoppedAt, noPoseFrom };
}

const round = (v: number, step: number, dir: "down" | "up") => Math.round((dir === "down" ? Math.floor(v / step + 1e-9) : Math.ceil(v / step - 1e-9)) * step * 1e6) / 1e6;

export function fitLimits(rig: RigConfig, marks: readonly LimitMark[], margins: Margins = DEFAULT_MARGINS): Fit {
  const legOf = (ch: number) => rig.servos.findIndex((s) => s.channel === ch);

  // 1. Trims from the latest "level" mark per servo.
  const trims: TrimSuggestion[] = [];
  const servos = rig.servos.map((s) => ({ ...s }));
  const latestLevel = new Map<number, LimitMark>();
  for (const m of marks) if (m.kind === "level") latestLevel.set(m.channel, m);
  for (const [ch, m] of latestLevel) {
    const leg = legOf(ch);
    if (leg < 0) continue;
    const s = servos[leg]!;
    const suggested = m.usByChannel[ch]! - s.centerUs;
    trims.push({ leg, label: servoLabel(rig, leg), current: s.trimUs, suggested });
    s.trimUs = suggested;
  }
  trims.sort((a, b) => a.label - b.label);
  const calRig: RigConfig = { ...rig, servos };
  const layout = buildLayout(rig.geometry);

  // 2. Re-run the model at each limit mark.
  const results: MarkResult[] = marks
    .filter((m) => m.kind !== "level")
    .map((mark) => {
      const leg = legOf(mark.channel);
      const empty = { mark, leg, alphaDeg: null, pose: null, faults: null, measure: null, overshoot: null, sweep: null };
      if (leg < 0) return { ...empty, problem: `No servo on channel ${mark.channel} in the loaded rig.json.` };
      if (servos.some((s) => !(mark.usByChannel[s.channel]! >= FIRMWARE_MIN_US && mark.usByChannel[s.channel]! <= FIRMWARE_MAX_US)))
        return { ...empty, problem: "The log entry is missing a pulse width for one of the servos." };
      const alphaDeg = servos.map((s) => usToDeg(s, mark.usByChannel[s.channel]!));
      const pose = forwardFromHome(calRig, alphaDeg, layout);
      const sol = pose ? solve(layout, rig.geometry, rig.limits, pose, rig.collision) : null;
      const faults = sol ? sol.legs.map((l) => l.faults) : null;
      const base = { mark, leg, alphaDeg, pose, faults };
      if (mark.kind === "clear") return { ...base, measure: null, overshoot: null, problem: null, sweep: clearSweep(rig, calRig, layout, alphaDeg, leg) };

      let measure: MarkResult["measure"] = null;
      let problem: string | null = null;
      const l = sol?.legs[leg];
      switch (mark.cause) {
        case "horn-stop":
          measure = { param: mark.kind === "max" ? "servoMaxDeg" : "servoMinDeg", value: alphaDeg[leg]! };
          break;
        case "ball-bottom":
        case "ball-top":
        case "rod-horn":
        case "rod-servo":
          if (!l) {
            problem = "The model cannot build these horn angles, so it cannot measure this joint. Check the geometry in rig.json.";
            break;
          }
          if (mark.cause === "ball-bottom") measure = { param: "ballSwivelDeg", value: l.swivelBottom / DEG };
          else if (mark.cause === "ball-top") measure = { param: "ballSwivelDeg", value: l.swivelTop / DEG };
          else if (mark.cause === "rod-horn") measure = { param: "hornRodMinDeg", value: hornRodAngle(l) / DEG };
          else measure = { param: "rodRadius", value: rodBodyGap(layout, rig.collision, l) };
          break;
        case "binding":
          problem = pose
            ? "Binding with nothing touching points at the geometry, not a limit: the model builds this pose without strain."
            : "The model cannot build these horn angles either, which agrees with the binding.";
          break;
        default:
          problem = "No limit in rig.json models this cause.";
      }
      let overshoot: number | null = null;
      if (measure) {
        const current = currentValue(rig, measure.param);
        overshoot = PARAMS[measure.param].side === "upper" ? current - measure.value : measure.value - current;
      }
      return { ...base, measure, overshoot, problem, sweep: null };
    });

  // 3. Most restrictive contact per limit, less the margin; clear sweeps loosen what they need to pass.
  const suggestions: Suggestion[] = [];
  for (const param of Object.keys(PARAMS) as LimitParam[]) {
    const info = PARAMS[param];
    const upper = info.side === "upper";
    const hits = results.filter((r) => r.measure?.param === param);
    const clears = results.filter((r) => r.sweep?.needs.some((x) => x.param === param));
    if (!hits.length && !clears.length) continue;
    const current = currentValue(rig, param);
    const mm = info.unit === "mm";
    // Furthest a clear sweep went: an "upper" limit must be at least this, a "lower" one at most.
    const needs = clears.map((r) => r.sweep!.needs.find((x) => x.param === param)!.value);
    const need = needs.length ? (upper ? Math.max(...needs) : Math.min(...needs)) : null;

    let measured: number, suggested: number;
    let warn: string | null = null;
    if (hits.length) {
      const values = hits.map((r) => r.measure!.value);
      measured = upper ? Math.min(...values) : Math.max(...values);
      const margin = mm ? margins.mm : margins.deg;
      suggested = upper ? round(measured - margin, mm ? 0.1 : 0.5, "down") : round(measured + margin, mm ? 0.1 : 0.5, "up");
      if (need !== null && (upper ? need > measured + 1e-9 : need < measured - 1e-9))
        warn = "A clear sweep went past a marked contact for this limit. Check those marks: one of them has the wrong servo, cause or kind.";
    } else {
      measured = need!;
      // Loosen only as far as the sweep needs (0.1 steps, outward so the cleared angles pass); never tighten.
      const ok = upper ? current >= need! : current < need! || (param !== "rodRadius" && current <= need!);
      // rodRadius is the one strict check (gap <= rodRadius fires), so its limit must sit just under the gap.
      suggested = ok ? current : upper ? round(need!, 0.1, "up") : round(param === "rodRadius" ? need! - 1e-6 : need!, 0.1, "down");
    }
    const change = Math.abs(suggested - current) < 1e-9 ? "same" : upper === suggested < current ? "tighter" : "looser";
    const servoCount = new Set([...hits, ...clears].map((r) => r.mark.channel)).size;
    const suspect = hits.some((r) => Math.abs(r.overshoot!) > (mm ? SUSPECT_GAP.mm : SUSPECT_GAP.deg));
    warn ??=
      change === "looser" && servoCount < rig.servos.length
        ? `Loosens the limit from ${servoCount} of ${rig.servos.length} servos. One limit covers every servo, so mark the rest before relying on it.`
        : suspect && param !== "servoMaxDeg" && param !== "servoMinDeg"
          ? "A mark is far from the current limit. Check that the cause is right; if it is, the geometry in rig.json is probably off at that pose."
          : null;
    const source = hits.length && clears.length ? "both" : hits.length ? "contact" : "clear";
    suggestions.push({ param, current, measured, suggested, source, marks: hits.length + clears.length, servos: servoCount, change, warn });
  }

  const changed = suggestions.filter((s) => s.change !== "same");
  const trimChanged = trims.filter((t) => t.suggested !== t.current);
  let out = rig;
  if (changed.length || trimChanged.length) {
    const limits = { ...rig.limits }, collision = { ...rig.collision };
    for (const s of changed) {
      if (s.param === "hornRodMinDeg" || s.param === "rodRadius") collision[s.param] = s.suggested;
      else limits[s.param] = s.suggested;
    }
    const parts = [
      ...changed.map((s) => `${s.param} ${s.current} -> ${s.suggested}`),
      ...trimChanged.map((t) => `servo ${t.label} trimUs ${t.current} -> ${t.suggested}`),
    ];
    const date = new Date().toISOString().slice(0, 10);
    const line = `${date}: from ${marks.length} limit-finder marks: ${parts.join(", ")}.`;
    out = { ...rig, limits, collision, servos, notes: rig.notes ? `${rig.notes} ${line}` : line };
  }
  return { results, suggestions, trims, rig: out };
}

function currentValue(rig: RigConfig, p: LimitParam): number {
  return p === "hornRodMinDeg" || p === "rodRadius" ? rig.collision[p] : rig.limits[p];
}

const CAUSES = Object.keys(CAUSE_LABEL) as MarkCause[];

/** Validate an exported mark log (untrusted JSON text). Throws with the reason. */
export function parseMarkLog(text: string): LimitMark[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Not valid JSON.");
  }
  const log = raw as Partial<MarkLog>;
  if (!log || log.kind !== "stewart-limit-marks" || log.version !== 1 || !Array.isArray(log.marks))
    throw new Error("Not a limit-marks log (expected kind \"stewart-limit-marks\", version 1).");
  return log.marks.map((m, i) => {
    const ok =
      m && typeof m.id === "string" && typeof m.time === "string" && typeof m.rigName === "string" &&
      Number.isInteger(m.channel) && Number.isInteger(m.label) && ["max", "min", "level", "clear"].includes(m.kind) &&
      (m.kind === "level" || m.kind === "clear" || CAUSES.includes(m.cause as MarkCause)) &&
      Array.isArray(m.usByChannel) && m.usByChannel.length === 6 && m.usByChannel.every((u) => Number.isFinite(u));
    if (!ok) throw new Error(`Mark ${i + 1} is malformed.`);
    return { ...m, usByChannel: [...m.usByChannel] };
  });
}

export const markLogJson = (marks: readonly LimitMark[]): string =>
  JSON.stringify({ kind: "stewart-limit-marks", version: 1, marks: [...marks] } satisfies MarkLog, null, 2) + "\n";
