/**
 * Runs the flight sim in the browser: steps it with wall-clock time, reads the pilot's
 * keyboard or gamepad, passes each washout pose through the rig limiter and writes the
 * result to the sim store as the platform pose.
 *
 * The store pose is what the 3D view draws and what live hardware control follows, so a
 * flight reaches the rig through the same validated, rate-limited path as the sliders.
 */
import {
  CueMeter, FlightSim, G0, SCENARIOS, bodyToRig, linearize, modes,
  type Mode, type PilotInput, type Scenario, type Telemetry, type TurbulenceLevel, type WashoutParams,
} from "@stewart/flight";
import { PoseLimiter } from "@stewart/kinematics";
import { HOME, useSim } from "../store.ts";

/** One plotted sample: aircraft vs platform, rig axes. Forces m/s² (heave with 1 g removed), rates °/s. */
export interface Sample {
  t: number;
  ac: [number, number, number, number];
  pl: [number, number, number, number];
}

export interface FlightStatus {
  running: boolean;
  scenario: Scenario;
  turbulence: TurbulenceLevel;
  tel: Telemetry;
  /** Fraction of the washout pose kept by the limiter on the last frame (1 = untouched). */
  scale: number;
  /** Share of recent frames the limiter had to scale, 0..1. */
  clipShare: number;
  gamepad: string | null;
  modes: Mode[];
  params: WashoutParams;
  pilot: PilotInput;
}

export const HISTORY_S = 15;
const SAMPLE_EVERY = 2; // plot at 50 Hz
const DEG = 180 / Math.PI;

const KEYS = {
  pitchUp: ["ArrowDown"], pitchDown: ["ArrowUp"], rollLeft: ["ArrowLeft"], rollRight: ["ArrowRight"],
  yawLeft: ["a", "A"], yawRight: ["d", "D"], throttleUp: ["w", "W"], throttleDown: ["s", "S"],
};

const typingIn = (el: EventTarget | null) =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["range", "checkbox", "radio", "button"].includes(el.type)) || el instanceof HTMLSelectElement;

export class FlightController {
  private sim = new FlightSim(SCENARIOS[0]);
  private meter = new CueMeter();
  private limiter = new PoseLimiter(1);
  private held = new Set<string>();
  private raf = 0;
  private last = 0;
  private stepCount = 0;
  private clipHist: boolean[] = [];
  private smooth: [number, number, number, number] = [0, 0, 0, 0];
  private listeners = new Set<(s: FlightStatus) => void>();
  history: Sample[] = [];
  status: FlightStatus;

  constructor() {
    this.status = {
      running: false, scenario: this.sim.scenario, turbulence: this.sim.turbulenceLevel, tel: this.sim.telemetry,
      scale: 1, clipShare: 0, gamepad: null, modes: this.computeModes(), params: { ...this.sim.washout.params }, pilot: { ...this.sim.pilot },
    };
  }

  subscribe(fn: (s: FlightStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<FlightStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn(this.status);
  }

  private computeModes(): Mode[] {
    try {
      return modes(linearize(this.sim.ac, this.sim.trim));
    } catch {
      return [];
    }
  }

  start(): void {
    if (this.status.running) return;
    if (this.sim.telemetry.crashed) this.reset();
    this.last = performance.now();
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKey);
    window.addEventListener("blur", this.onBlur);
    this.set({ running: true });
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Pause: the aircraft freezes and the platform holds its last pose. */
  pause(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("keyup", this.onKey);
    window.removeEventListener("blur", this.onBlur);
    this.held.clear();
    this.set({ running: false });
  }

  /** Back to the scenario's start, platform to home. */
  reset(scenario: Scenario = this.sim.scenario): void {
    this.sim.reset(scenario);
    this.meter.reset();
    this.limiter.reset();
    this.history = [];
    this.clipHist = [];
    this.smooth = [0, 0, 0, 0];
    this.stepCount = 0;
    useSim.getState().setFullPose(HOME);
    this.set({
      scenario, turbulence: this.sim.turbulenceLevel, tel: this.sim.telemetry, scale: 1, clipShare: 0,
      modes: this.computeModes(), pilot: { ...this.sim.pilot },
    });
  }

  /** Stop flying and leave the platform at home. */
  stop(): void {
    this.pause();
    this.reset();
  }

  setTurbulence(level: TurbulenceLevel): void {
    this.sim.setTurbulence(level);
    this.set({ turbulence: level });
  }

  setParams(p: WashoutParams): void {
    this.sim.washout.setParams(p);
    this.set({ params: { ...p } });
  }

  private onBlur = () => this.held.clear();

  private onKey = (e: KeyboardEvent) => {
    if (typingIn(e.target)) return;
    if (e.type === "keydown" && (e.key === " " || e.key === "Escape")) {
      e.preventDefault();
      this.pause();
      return;
    }
    const all = Object.values(KEYS).flat();
    if (!all.includes(e.key)) return;
    e.preventDefault();
    if (e.type === "keydown") this.held.add(e.key);
    else this.held.delete(e.key);
  };

  /** Keyboard: axes ramp toward full deflection while held and recentre when released. */
  private readPilot(dt: number): void {
    const p = this.sim.pilot;
    const on = (keys: string[]) => keys.some((k) => this.held.has(k));
    const axis = (cur: number, neg: string[], pos: string[], full: number) => {
      const target = (on(pos) ? full : 0) - (on(neg) ? full : 0);
      const rate = target === 0 ? 3 : 1.5;
      return cur + Math.max(-rate * dt, Math.min(rate * dt, target - cur));
    };
    let pitch = axis(p.pitch, KEYS.pitchDown, KEYS.pitchUp, 0.6);
    let roll = axis(p.roll, KEYS.rollLeft, KEYS.rollRight, 0.6);
    let yaw = axis(p.yaw, KEYS.yawLeft, KEYS.yawRight, 0.6);
    let throttle = p.throttle + ((on(KEYS.throttleUp) ? 1 : 0) - (on(KEYS.throttleDown) ? 1 : 0)) * 0.4 * dt;

    let padName: string | null = null;
    const pad = navigator.getGamepads?.().find((g) => g && g.connected);
    if (pad) {
      padName = pad.id;
      const dz = (v: number | undefined) => (v === undefined || Math.abs(v) < 0.08 ? 0 : v);
      const [lx, ly, rx] = [dz(pad.axes[0]), dz(pad.axes[1]), dz(pad.axes[2])];
      // Stick pulled back (toward you, +y on a standard pad) = nose up.
      if (lx || ly || rx) {
        roll = lx;
        pitch = ly;
        yaw = rx;
      }
      const lt = pad.buttons[6]?.value ?? 0, rt = pad.buttons[7]?.value ?? 0;
      throttle += (rt - lt) * 0.4 * dt;
    }
    this.sim.pilot = { pitch, roll, yaw, throttle: Math.min(1, Math.max(0, throttle)) };
    if (padName !== this.status.gamepad) this.set({ gamepad: padName });
  }

  private frame = (now: number) => {
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    if (this.sim.scenario.id === "free") this.readPilot(dt);
    const steps = this.sim.advance(dt);

    const s = useSim.getState();
    let scale = this.status.scale;
    let pose = null;
    for (const tel of steps) {
      // Limit every fixed step so the cue meter sees the pose the platform really takes.
      const lp = this.limiter.limit(s.layout, s.geometry, s.limits, tel.cue, 0.01, s.rig.collision);
      pose = lp.pose;
      scale = lp.scale;
      this.clipHist.push(lp.scale < 0.999);
      if (this.clipHist.length > 300) this.clipHist.shift();
      this.meter.push(pose, 0.01);
      if (this.stepCount++ % SAMPLE_EVERY === 0) this.sample(tel);
    }
    if (pose) s.setFullPose(pose);
    const tel = this.sim.telemetry;
    this.set({
      tel, scale, clipShare: this.clipHist.filter(Boolean).length / Math.max(1, this.clipHist.length), pilot: { ...this.sim.pilot },
    });
    if (tel.crashed) {
      this.pause();
      return;
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  private sample(tel: Telemetry): void {
    const f = bodyToRig(tel.fPilot);
    const w = bodyToRig(tel.w);
    const m = this.meter;
    // Light display smoothing on the platform signal: it is a second difference of the pose.
    const raw: [number, number, number, number] = [m.f[0], m.f[1], m.f[2] - G0, m.w[0] * DEG];
    this.smooth = this.smooth.map((v, i) => v + 0.35 * (raw[i]! - v)) as [number, number, number, number];
    this.history.push({ t: tel.t, ac: [f[0], f[1], f[2] - G0, w[0] * DEG], pl: [...this.smooth] });
    const cutoff = tel.t - HISTORY_S;
    while (this.history.length && this.history[0]!.t < cutoff) this.history.shift();
  }
}

export const flight = new FlightController();
