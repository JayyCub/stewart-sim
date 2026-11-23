/**
 * Live manual control: stream the sim's pose to the rig through firmware/servo_test.
 *
 * Safety model (same rules as the bench scripts):
 *  - IK, limits and collisions come from the loaded rig.json (not slider-edited geometry).
 *  - Every frame sent is a pose that passed the full check (followStep), and its pulses are
 *    checked against the firmware window (frameUs). The Uno clamps again.
 *  - Horn speed is capped at speed × motion.maxHornDegPerSec; with no such limit in rig.json,
 *    live control refuses to start.
 *  - A target pose that fails the check is ignored; the rig keeps the last valid target. If
 *    the straight path to the target crosses a limit, the rig stops just short of it.
 *  - Stop flushes the Uno's queue: the servos hold the frame playing now, and that pose is
 *    known exactly (we track what was queued), so following can resume from it.
 *  - The servos don't report position, so after connecting (or any fault) the position is
 *    unknown and the only way in is "Level": all horns to 0° in one frame, like servo_reset.
 */
import { DEG, buildLayout, followStep, solve, type Commanded, type Layout, type Pose } from "@stewart/kinematics";
import { frameUs, servoLabel, type RigConfig } from "@stewart/rig-config";
import { FRAME_MS, Link, QUEUE_LEN, type PortLike } from "./link.ts";

export type Phase =
  /** No port open. */
  | "disconnected"
  | "connecting"
  /** Connected; servos limp or at an unknown position. Needs Level before moving. */
  | "unknown"
  /** Following the target pose. */
  | "live"
  /** Holding a known pose; following paused. */
  | "held"
  /** A command is in flight (level, stop, release, disconnect). */
  | "busy";

export interface LiveStatus {
  phase: Phase;
  /** Last error or notice, shown to the user. */
  message: { text: string; bad: boolean } | null;
  /** Why the rig is not moving toward the target, if it is stuck at a limit. */
  blocked: string | null;
  /** The target pose fails the checks on the loaded rig, so it is being ignored. */
  targetRejected: boolean;
  /** Last frame queued on the Uno (leads the servos by the queued time). */
  commanded: Commanded | null;
  queued: number;
  underruns: number;
  framesSent: number;
  /** Fraction of motion.maxHornDegPerSec to use, 0.1..1. */
  speed: number;
}

export interface LiveDeps {
  /** The pose the user is asking for (the sim's sliders). */
  getTarget(): Pose;
  /** The loaded rig config. */
  getRig(): RigConfig;
  /** Set the sim's pose to the rig's pose (after Level, or when stopped mid-move). */
  setTarget(pose: Pose): void;
  sleep?(ms: number): Promise<void>;
}

/**
 * Frames kept queued on the Uno: 80 ms of cushion against browser timer jitter, and 80 ms of
 * latency between a slider move and the servos. Each frame takes ~5 ms of serial round trip, so
 * this is plenty in a foreground tab; an underrun only holds the last (valid) frame for 20 ms.
 */
export const TARGET_FILL = 4;
export const HOME: Pose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class LiveController {
  status: LiveStatus = {
    phase: "disconnected", message: null, blocked: null, targetRejected: false,
    commanded: null, queued: 0, underruns: 0, framesSent: 0, speed: 1,
  };

  private readonly deps: LiveDeps;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly listeners = new Set<(s: LiveStatus) => void>();
  private link: Link | null = null;
  private loop: Promise<void> | null = null;
  /** Rig the current position was established with; a different loaded rig stops live control. */
  private rig: RigConfig | null = null;
  private layout: Layout | null = null;
  /** Frames queued since the last flush, oldest first; the last is the newest frame sent. */
  private sent: Commanded[] = [];
  private streaming = false;
  private lastTarget: Pose = HOME;

  constructor(deps: LiveDeps) {
    this.deps = deps;
    this.sleep = deps.sleep ?? realSleep;
  }

  subscribe(fn: (s: LiveStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<LiveStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn(this.status);
  }

  private say(text: string, bad = false): void {
    this.set({ message: { text, bad } });
  }

  setSpeed(f: number): void {
    this.set({ speed: Math.min(1, Math.max(0.1, f)) });
  }

  async connect(port: PortLike): Promise<void> {
    if (this.status.phase !== "disconnected") return;
    this.set({ phase: "connecting", message: null });
    try {
      const link = await Link.open(port, this.sleep);
      link.onLost = (why) => this.lost(why);
      this.link = link;
      this.set({ phase: "unknown", commanded: null, queued: 0, underruns: 0, framesSent: 0 });
      this.say("Connected. Servo positions are unknown until you level the horns.");
    } catch (e) {
      this.set({ phase: "disconnected" });
      this.say((e as Error).message, true);
    }
  }

  /** From "unknown": every horn to 0° in one frame (each servo at full speed), then follow. */
  async level(): Promise<void> {
    if (this.status.phase !== "unknown" || !this.link) return;
    const rig = this.deps.getRig();
    if (!rig.motion?.maxHornDegPerSec) {
      this.say("Refused: rig.json has no motion.maxHornDegPerSec, so there is no horn speed limit to follow at.", true);
      return;
    }
    const layout = buildLayout(rig.geometry);
    const home = solve(layout, rig.geometry, rig.limits, HOME, rig.collision);
    if (!home.ok) {
      this.say("Refused: home pose fails the limit checks on the loaded rig.", true);
      return;
    }
    const cmd: Commanded = { pose: HOME, alphaDeg: home.legs.map((l) => l.alpha / DEG) };
    this.set({ phase: "busy" });
    try {
      const us = frameUs(rig, cmd.alphaDeg);
      await this.link.flush(); // "A" is refused while a queue plays
      await this.link.setAll(us);
    } catch (e) {
      return this.fault(e);
    }
    this.rig = rig;
    this.layout = layout;
    this.sent = [cmd];
    this.lastTarget = HOME;
    this.deps.setTarget(HOME);
    this.set({ commanded: cmd, message: null, blocked: null });
    this.start();
  }

  /** From "held": follow the target again, starting from the held pose. */
  resume(): void {
    if (this.status.phase !== "held") return;
    this.start();
  }

  private start(): void {
    this.set({ phase: "live", blocked: null });
    this.loop = this.run();
  }

  /** Stop at once: drop queued frames, hold the pose playing now, and point the sim at it. */
  async stop(): Promise<void> {
    if (this.status.phase !== "live" || !this.link) return;
    this.set({ phase: "busy" });
    try {
      const dropped = await this.link.flush();
      await this.loop;
      const held = this.sent[Math.max(0, this.sent.length - 1 - dropped)]!;
      this.sent = [held];
      this.streaming = false;
      this.lastTarget = held.pose;
      this.deps.setTarget(held.pose);
      this.set({ phase: "held", commanded: held, queued: 0, blocked: null });
    } catch (e) {
      this.fault(e);
    }
  }

  /** Make every servo limp. Position becomes unknown. */
  async release(): Promise<void> {
    const p = this.status.phase;
    if (!this.link || (p !== "live" && p !== "held" && p !== "unknown")) return;
    if (p === "live") await this.stop();
    if (!this.link) return;
    this.set({ phase: "busy" });
    try {
      await this.link.flush();
      const rig = this.rig ?? this.deps.getRig();
      for (const s of rig.servos) await this.link.off(s.channel);
      this.forget();
      this.set({ phase: "unknown" });
      this.say("Servos released (limp). Level the horns to move again.");
    } catch (e) {
      this.fault(e);
    }
  }

  /** Close the port. Servos keep holding whatever they were last sent; release first for limp. */
  async disconnect(): Promise<void> {
    if (!this.link) return;
    if (this.status.phase === "live") await this.stop();
    const link = this.link;
    this.link = null;
    this.forget();
    this.set({ phase: "busy" });
    await link.close();
    this.set({ phase: "disconnected" });
  }

  private forget(): void {
    this.rig = null;
    this.layout = null;
    this.sent = [];
    this.streaming = false;
    this.set({ commanded: null, queued: 0, blocked: null, targetRejected: false });
  }

  private lost(why: string): void {
    this.link = null;
    this.forget();
    this.set({ phase: "disconnected" });
    this.say(why, true);
  }

  /** A command failed: try to hold (flush), and fall back to "unknown" so the next move starts with Level. */
  private async fault(e: unknown): Promise<void> {
    const text = (e as Error).message;
    if (this.link && !this.link.isClosed) {
      try {
        await this.link.flush();
      } catch { /* report the first error */ }
      this.forget();
      this.set({ phase: "unknown" });
      this.say(`Stopped: ${text} Servos are holding; level the horns to continue.`, true);
    } else {
      this.lost(`Stopped: ${text}`);
    }
  }

  /** The target pose if it passes every check on the bound rig, else the last one that did. */
  private validTarget(rig: RigConfig, layout: Layout): Pose {
    const t = this.deps.getTarget();
    const ok = solve(layout, rig.geometry, rig.limits, t, rig.collision).ok;
    if (ok) this.lastTarget = t;
    if (ok === this.status.targetRejected) this.set({ targetRejected: !ok });
    return this.lastTarget;
  }

  private async run(): Promise<void> {
    const link = this.link!, rig = this.rig!, layout = this.layout!;
    const maxStep = () => rig.motion!.maxHornDegPerSec * this.status.speed * (FRAME_MS / 1000);
    try {
      while (this.status.phase === "live") {
        if (this.deps.getRig() !== rig) {
          await link.flush();
          this.forget();
          this.set({ phase: "unknown" });
          this.say("A different rig.json was loaded, so live control stopped (servos holding). Level the horns to continue.", true);
          return;
        }
        const from = this.sent[this.sent.length - 1]!;
        const r = followStep(layout, rig.geometry, rig.limits, from, this.validTarget(rig, layout), maxStep(), rig.collision);
        if (r.kind === "step") {
          const us = frameUs(rig, r.next.alphaDeg);
          // Record before sending: a Stop issued now flushes after this frame, and counts it as dropped.
          this.sent.push(r.next);
          if (this.sent.length > QUEUE_LEN + 2) this.sent.splice(0, this.sent.length - (QUEUE_LEN + 2));
          this.streaming = true;
          const [queued, underruns] = await link.queueFrame(us);
          this.set({
            commanded: r.next, queued, underruns, framesSent: this.status.framesSent + 1,
            blocked: null,
          });
          if (queued >= TARGET_FILL) await this.sleep((queued - TARGET_FILL + 1) * FRAME_MS);
        } else {
          const blocked = r.kind === "blocked"
            ? (r.leg === undefined ? r.reason : `servo ${servoLabel(rig, r.leg)}: ${r.reason}`)
            : null;
          if (blocked !== this.status.blocked) this.set({ blocked });
          if (this.streaming) {
            await link.endStream(); // the Uno plays out the queue and holds; no underruns while idle
            this.streaming = false;
          }
          await this.sleep(FRAME_MS);
          if (this.status.queued > 0) this.set({ queued: Math.max(0, this.status.queued - 1) });
        }
      }
    } catch (e) {
      if (this.status.phase === "live") await this.fault(e);
    }
  }
}
