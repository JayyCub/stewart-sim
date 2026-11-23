/**
 * Jog single servos on the real rig to find its physical limits (see limitfit.ts).
 *
 * Safety model:
 *  - The servos don't report position, so after connecting (or any fault) the position is
 *    unknown and the only way in is "Level": all horns to 0° in one frame, like servo_reset.
 *  - Every move is ramped: no horn turns faster than the jog speed (capped at
 *    motion.maxHornDegPerSec), one "A" frame every ~20 ms. Each step covers the real time since
 *    the last one, but never more than MAX_STEP_MS of it, so a stalled browser slows the ramp
 *    instead of making the servo jump.
 *  - Every frame is checked against the firmware window (frameUs throws), and the Uno clamps again.
 *  - With `beyond` off (the default), a step that would take a configuration the model accepts
 *    into one it rejects (servo range, ball swivel, collisions, or no pose at all) is refused,
 *    and the servo holds just short of it. Turning `beyond` on is the bench equivalent of
 *    --ignore-limits: the model's limits become readouts, only the firmware window applies.
 *  - Stop holds the current frame. "A" frames act at once, so the commanded angles are where
 *    the servos are headed with nothing queued behind them.
 */
import { DEG, buildLayout, forward, solve, type Layout, type LegFault, type Pose } from "@stewart/kinematics";
import { FIRMWARE_MAX_US, FIRMWARE_MIN_US, frameUs, servoLabel, type RigConfig } from "@stewart/rig-config";
import { FRAME_MS, Link, type PortLike } from "./link.ts";
import { FAULT_TEXT } from "./limitfit.ts";

export type JogPhase = "disconnected" | "connecting" | "unknown" | "ready" | "moving" | "busy";

export interface JogStatus {
  phase: JogPhase;
  message: { text: string; bad: boolean } | null;
  /** Horn angles last sent, leg order, degrees. Null while the position is unknown. */
  alphaDeg: number[] | null;
  /** Where each horn is headed, leg order, degrees (the sliders). Null while the position is unknown. */
  target: number[] | null;
  /** Pulses last sent, by channel. */
  usByChannel: number[] | null;
  /** Pose the model gives for the commanded angles; null if it cannot build them. */
  pose: Pose | null;
  /** Model faults per leg at that pose; null when there is no pose. */
  faults: LegFault[][] | null;
  /** Jog speed, degrees per second. */
  speed: number;
  /** Let moves pass the model's limits (firmware window still applies). */
  beyond: boolean;
  /** Why the last move stopped short of where it was asked to go. */
  stoppedBy: string | null;
}

export interface JogDeps {
  getRig(): RigConfig;
  /** Show the model's pose for the commanded angles (the 3D view). */
  showPose?(pose: Pose): void;
  sleep?(ms: number): Promise<void>;
  /** Clock in ms (tests use a virtual one). */
  now?(): number;
}

export const DEFAULT_JOG_SPEED = 20;
/** Most elapsed time one step may make up for. */
export const MAX_STEP_MS = 2.5 * FRAME_MS;
const MIN_JOG_SPEED = 2;
const HOME: Pose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class JogController {
  status: JogStatus = {
    phase: "disconnected", message: null, alphaDeg: null, target: null, usByChannel: null, pose: null, faults: null,
    speed: DEFAULT_JOG_SPEED, beyond: false, stoppedBy: null,
  };

  private readonly deps: JogDeps;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly listeners = new Set<(s: JogStatus) => void>();
  private link: Link | null = null;
  private rig: RigConfig | null = null;
  private layout: Layout | null = null;
  private targetDeg: number[] = [];
  private loop: Promise<void> | null = null;

  constructor(deps: JogDeps) {
    this.deps = deps;
    this.sleep = deps.sleep ?? realSleep;
    this.now = deps.now ?? (() => performance.now());
  }

  /** Kept in step with status.target so the sliders show it. */
  private get target(): number[] {
    return this.targetDeg;
  }
  private set target(t: number[]) {
    this.targetDeg = t;
    this.set({ target: t.length ? [...t] : null });
  }

  /** Horn angles (degrees) at the ends of the firmware's pulse window for one leg, low first, 0.05° inside. */
  windowDeg(leg: number, rig: RigConfig = this.rig ?? this.deps.getRig()): [number, number] {
    const s = rig.servos[leg]!;
    const lo = (FIRMWARE_MIN_US - s.centerUs - s.trimUs) / (s.direction * s.usPerDeg);
    const hi = (FIRMWARE_MAX_US - s.centerUs - s.trimUs) / (s.direction * s.usPerDeg);
    return lo < hi ? [lo + 0.05, hi - 0.05] : [hi + 0.05, lo - 0.05];
  }

  subscribe(fn: (s: JogStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<JogStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn(this.status);
  }

  private say(text: string, bad = false): void {
    this.set({ message: { text, bad } });
  }

  /** Fastest allowed jog speed: the rig's horn speed limit. 0 if rig.json has none. */
  maxSpeed(): number {
    return this.deps.getRig().motion?.maxHornDegPerSec ?? 0;
  }

  setSpeed(degPerSec: number): void {
    this.set({ speed: Math.min(this.maxSpeed(), Math.max(MIN_JOG_SPEED, degPerSec)) });
  }

  setBeyond(on: boolean): void {
    this.set({ beyond: on, stoppedBy: null });
  }

  async connect(port: PortLike): Promise<void> {
    if (this.status.phase !== "disconnected") return;
    this.set({ phase: "connecting", message: null });
    try {
      const link = await Link.open(port, this.sleep);
      link.onLost = (why) => this.lost(why);
      this.link = link;
      this.set({ phase: "unknown" });
      this.say("Connected. Servo positions are unknown until you level the horns.");
    } catch (e) {
      this.set({ phase: "disconnected" });
      this.say((e as Error).message, true);
    }
  }

  /** From "unknown": every horn to 0° in one frame (each servo at its own full speed). */
  async level(): Promise<void> {
    if (this.status.phase !== "unknown" || !this.link) return;
    const rig = this.deps.getRig();
    if (!rig.motion?.maxHornDegPerSec) return this.say("Refused: rig.json has no motion.maxHornDegPerSec, so there is no speed limit to jog at.", true);
    const zeros = rig.servos.map(() => 0);
    this.set({ phase: "busy" });
    try {
      const us = frameUs(rig, zeros);
      await this.link.flush(); // "A" is refused while a queue plays (e.g. left over from a script)
      await this.link.setAll(us);
      this.rig = rig;
      this.layout = buildLayout(rig.geometry);
      this.target = zeros;
      this.set({ phase: "ready", alphaDeg: zeros, usByChannel: us, stoppedBy: null, message: null, speed: Math.min(this.status.speed, this.maxSpeed()) });
      this.applyModel(zeros, HOME);
    } catch (e) {
      await this.fault(e);
    }
  }

  /** Send one servo (leg index) to an angle, ramped. Moving a slider calls this. */
  setAngle(leg: number, deg: number): void {
    const p = this.status.phase;
    if ((p !== "ready" && p !== "moving") || !this.rigStillLoaded()) return;
    const t = [...this.target];
    t[leg] = deg;
    this.moveTo(t);
  }

  /** Ramp every horn back to level (0°). */
  home(): void {
    const p = this.status.phase;
    if ((p !== "ready" && p !== "moving") || !this.rigStillLoaded()) return;
    this.moveTo(this.target.map(() => 0));
  }

  private moveTo(t: number[]): void {
    const rig = this.rig!;
    // Keep the target inside the firmware window, so the ramp ends at the edge instead of erroring there.
    const clipped = t.map((d, i) => {
      const [a, b] = this.windowDeg(i, rig);
      return Math.min(b, Math.max(a, d));
    });
    const clippedLeg = clipped.findIndex((d, i) => Math.abs(d - t[i]!) > 1e-9);
    this.target = clipped;
    this.set({
      stoppedBy: clippedLeg >= 0 ? `servo ${servoLabel(rig, clippedLeg)}: end of the firmware window (${FIRMWARE_MIN_US}-${FIRMWARE_MAX_US} us)` : null,
    });
    if (this.status.phase === "ready") {
      this.set({ phase: "moving" });
      this.loop = this.run();
    }
  }

  /** Stop at once: the servos hold the frame sent last. */
  async stop(): Promise<void> {
    if (this.status.phase !== "moving") return;
    this.target = [...this.status.alphaDeg!];
    await this.loop;
  }

  /** Make every servo limp. Position becomes unknown. */
  async release(): Promise<void> {
    const p = this.status.phase;
    if (!this.link || (p !== "ready" && p !== "moving" && p !== "unknown")) return;
    await this.stop();
    if (!this.link) return;
    this.set({ phase: "busy" });
    try {
      await this.link.flush();
      for (const s of (this.rig ?? this.deps.getRig()).servos) await this.link.off(s.channel);
      this.forget();
      this.set({ phase: "unknown" });
      this.say("Servos released (limp). Level the horns to move again.");
    } catch (e) {
      await this.fault(e);
    }
  }

  /** Close the port. Servos keep holding the last frame; release first for limp. */
  async disconnect(): Promise<void> {
    if (!this.link) return;
    await this.stop();
    const link = this.link;
    this.link = null;
    this.forget();
    this.set({ phase: "busy" });
    await link.close();
    this.set({ phase: "disconnected" });
  }

  private rigStillLoaded(): boolean {
    if (this.deps.getRig() === this.rig) return true;
    this.forget();
    this.set({ phase: "unknown" });
    this.say("A different rig.json was loaded (new calibration or limits), so the servos are holding as they were. Level the horns to continue.", true);
    return false;
  }

  private forget(): void {
    this.rig = null;
    this.layout = null;
    this.target = [];
    this.set({ alphaDeg: null, usByChannel: null, pose: null, faults: null, stoppedBy: null });
  }

  private lost(why: string): void {
    this.link = null;
    this.forget();
    this.set({ phase: "disconnected" });
    this.say(why, true);
  }

  private async fault(e: unknown): Promise<void> {
    const text = (e as Error).message;
    if (this.link && !this.link.isClosed) {
      this.forget();
      this.set({ phase: "unknown" });
      this.say(`Stopped: ${text} Servos are holding; level the horns to continue.`, true);
    } else this.lost(`Stopped: ${text}`);
  }

  /** Model check for a set of horn angles: pose (continuing from `guess`) and faults. */
  private evaluate(alphaDeg: readonly number[], guess: Pose | null): { pose: Pose | null; faults: LegFault[][] | null; ok: boolean } {
    const rig = this.rig!, layout = this.layout!;
    const pose = forward(layout, rig.geometry, alphaDeg.map((d) => d * DEG), guess ?? HOME);
    if (!pose) return { pose: null, faults: null, ok: false };
    const sol = solve(layout, rig.geometry, rig.limits, pose, rig.collision);
    return { pose, faults: sol.legs.map((l) => l.faults), ok: sol.ok };
  }

  private applyModel(alphaDeg: readonly number[], guess: Pose | null): void {
    const m = this.evaluate(alphaDeg, guess);
    this.set({ pose: m.pose, faults: m.faults });
    if (m.pose) this.deps.showPose?.(m.pose);
  }

  private describe(m: { pose: Pose | null; faults: LegFault[][] | null }): string {
    if (!m.pose || !m.faults) return "the model has no pose for these horn angles";
    const leg = m.faults.findIndex((f) => f.length > 0);
    return `servo ${servoLabel(this.rig!, leg)}: ${m.faults[leg]!.map((f) => FAULT_TEXT[f]).join(", ")}`;
  }

  private async run(): Promise<void> {
    const link = this.link!, rig = this.rig!;
    let last = this.now() - FRAME_MS;
    try {
      while (this.status.phase === "moving") {
        if (this.deps.getRig() !== rig) {
          this.rigStillLoaded();
          return;
        }
        const cur = this.status.alphaDeg!;
        const t = this.now();
        const maxStep = this.status.speed * (Math.min(MAX_STEP_MS, Math.max(0, t - last)) / 1000);
        last = t;
        const next = cur.map((d, i) => d + Math.max(-maxStep, Math.min(maxStep, this.target[i]! - d)));
        if (next.every((d, i) => Math.abs(d - cur[i]!) < 1e-9)) break;
        const curOk = this.status.pose !== null && this.status.faults!.every((f) => f.length === 0);
        const m = this.evaluate(next, this.status.pose);
        if (!this.status.beyond && curOk && !m.ok) {
          this.target = [...cur];
          this.set({ stoppedBy: `${this.describe(m)}. Turn on "Go past software limits" to keep going.` });
          break;
        }
        // frameUs rounds to whole microseconds and refuses anything outside the firmware window.
        const us = frameUs(rig, next);
        await link.setAll(us);
        this.set({ alphaDeg: next, usByChannel: us, pose: m.pose, faults: m.faults });
        if (m.pose) this.deps.showPose?.(m.pose);
        await this.sleep(FRAME_MS);
      }
      if (this.status.phase === "moving") this.set({ phase: "ready" });
    } catch (e) {
      if (this.status.phase === "moving") await this.fault(e);
    }
  }
}

