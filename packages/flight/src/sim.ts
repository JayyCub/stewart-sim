/**
 * The flight simulation loop: aircraft dynamics at a fixed 100 Hz, turbulence, the pilot or a
 * scripted manoeuvre, and washout cueing. One FlightSim drives both the sim app and the tests,
 * so a scripted manoeuvre runs identically in either place.
 */
import { LIGHT_AIRCRAFT, type Aircraft } from "./aircraft.ts";
import { Autopilot, type ApTarget } from "./autopilot.ts";
import { actuate, altitude, clampControls, climbRate, derivative, specificForceAt, step, type AirData, type Controls, type State } from "./dynamics.ts";
import { eulerFromQuat, type V3 } from "./math.ts";
import { trimLevel, type Trim } from "./trim.ts";
import { TURBULENCE_LEVELS, Turbulence, type TurbulenceLevel } from "./turbulence.ts";
import { DEFAULT_WASHOUT, Washout, type CuePose, type WashoutParams } from "./washout.ts";

export const DT = 0.01;
const DEG = Math.PI / 180;

/** Pilot stick and throttle: stick axes −1..1 (pitch +1 = pull back), throttle 0..1. */
export interface PilotInput {
  pitch: number;
  roll: number;
  yaw: number;
  throttle: number;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  /** Trim airspeed to start from, m/s. */
  startSpeed: number;
  turbulence: TurbulenceLevel;
  /** Length of the scripted part, s (Infinity for free flight). */
  duration: number;
  /** Either an autopilot target or direct controls at time t; null = pilot flies. */
  command(t: number, trim: Trim): { ap: ApTarget } | { controls: Controls } | null;
}

const START_ALT = 1000;
const CRUISE = 55;

export const SCENARIOS: Scenario[] = [
  {
    id: "free", name: "Free flight", description: "You fly, starting trimmed for level cruise at 107 kt. Hands off, it stays level; the platform shows what each input feels like.",
    startSpeed: CRUISE, turbulence: "off", duration: Infinity, command: () => null,
  },
  {
    id: "turn", name: "Coordinated turn",
    description: "Autopilot rolls into a 30° bank, holds altitude for 20 s, rolls out. In a coordinated turn the rider is pressed into the seat but not sideways, so the platform only cues the roll onset.",
    startSpeed: CRUISE, turbulence: "off", duration: 35,
    // Bank command ramps at 10°/s, as a pilot or autopilot would roll in.
    command: (t, trim) => ({ ap: { bank: Math.max(0, Math.min(30, (t - 3) * 10, (23 - t) * 10 + 30)) * DEG, alt: trim.alt, speed: trim.V } }),
  },
  {
    id: "power", name: "Full power from slow flight",
    description: "Throttle to full from 40 m/s while holding altitude. A long, steady forward push: the platform reproduces it by slowly tilting back (tilt coordination).",
    startSpeed: 40, turbulence: "off", duration: 30,
    command: (t, trim) => ({ ap: { bank: 0, alt: trim.alt, throttle: t > 2 ? 1 : trim.controls.throttle } }),
  },
  {
    id: "doublet", name: "Elevator doublet",
    description: "3° nose-up then 3° nose-down, one second each, then hands off. Excites the short-period mode (quick, well damped) and the phugoid (slow speed–altitude exchange, about 30 s).",
    startSpeed: CRUISE, turbulence: "off", duration: 60,
    command: (t, trim) => {
      const de = trim.controls.de + (t >= 2 && t < 3 ? 3 * DEG : t >= 3 && t < 4 ? -3 * DEG : 0);
      return { controls: { ...trim.controls, de } };
    },
  },
  {
    id: "turbulence", name: "Moderate turbulence",
    description: "Autopilot holds wings level and altitude through moderate turbulence. Bumps come through the translational and rotational channels.",
    startSpeed: CRUISE, turbulence: "moderate", duration: 40,
    command: (_t, trim) => ({ ap: { bank: 0, alt: trim.alt, speed: trim.V } }),
  },
];

export interface Telemetry {
  t: number;
  state: State;
  air: AirData;
  controls: Controls;
  /** Roll, pitch, heading, rad. */
  euler: V3;
  alt: number;
  climb: number;
  /** Specific force at the pilot's head and body rate, aircraft body axes. */
  fPilot: V3;
  w: V3;
  /** Platform pose from the washout, before any limit check (mm, rad, rig frame). */
  cue: CuePose;
  crashed: boolean;
  /** Scripted part finished. */
  done: boolean;
}

export interface FlightSimOptions {
  aircraft?: Aircraft;
  washout?: WashoutParams;
  seed?: number;
}

export class FlightSim {
  readonly ac: Aircraft;
  scenario: Scenario;
  trim: Trim;
  state: State;
  t = 0;
  pilot: PilotInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0.65 };
  turbulenceLevel: TurbulenceLevel;
  readonly washout: Washout;
  telemetry: Telemetry;
  private turb: Turbulence;
  private ap = new Autopilot();
  private seed: number;
  private accum = 0;
  /** Where the control surfaces and throttle actually are (after the actuator rate limits). */
  surfaces: Controls;

  constructor(scenario: Scenario = SCENARIOS[0]!, opts: FlightSimOptions = {}) {
    this.ac = opts.aircraft ?? LIGHT_AIRCRAFT;
    this.seed = opts.seed ?? 1;
    this.washout = new Washout(opts.washout ?? DEFAULT_WASHOUT);
    this.scenario = scenario;
    this.trim = trimLevel(this.ac, scenario.startSpeed, START_ALT);
    this.state = this.trim.state;
    this.turbulenceLevel = scenario.turbulence;
    this.turb = new Turbulence(TURBULENCE_LEVELS[scenario.turbulence], this.seed);
    this.surfaces = this.trim.controls;
    this.telemetry = this.measure(this.trim.controls, [0, 0, 0]);
    this.reset(scenario);
  }

  /** Start a scenario from its trim point, with the platform at rest. */
  reset(scenario: Scenario = this.scenario): void {
    this.scenario = scenario;
    this.trim = trimLevel(this.ac, scenario.startSpeed, START_ALT);
    this.state = this.trim.state;
    this.t = 0;
    this.accum = 0;
    this.pilot = { pitch: 0, roll: 0, yaw: 0, throttle: this.trim.controls.throttle };
    this.setTurbulence(scenario.turbulence);
    this.ap.reset();
    this.washout.reset();
    this.surfaces = this.trim.controls;
    this.telemetry = this.measure(this.trim.controls, [0, 0, 0]);
  }

  setTurbulence(level: TurbulenceLevel): void {
    this.turbulenceLevel = level;
    this.turb = new Turbulence(TURBULENCE_LEVELS[level], this.seed);
  }

  /** Pilot input → control surfaces, as deflections about the trim. */
  pilotControls(): Controls {
    const tc = this.trim.controls;
    return clampControls(this.ac, {
      de: tc.de + this.pilot.pitch * 15 * DEG,
      da: this.pilot.roll * 15 * DEG,
      dr: this.pilot.yaw * 20 * DEG,
      throttle: this.pilot.throttle,
    });
  }

  private controlsNow(): Controls {
    const cmd = this.t < this.scenario.duration ? this.scenario.command(this.t, this.trim) : null;
    if (!cmd) {
      // After a scripted run ends, hold its last autopilot target so the aircraft stays sensible.
      if (this.scenario.id !== "free" && this.t >= this.scenario.duration) {
        const last = this.scenario.command(Math.max(0, this.scenario.duration - DT), this.trim);
        if (last && "ap" in last) return this.ap.controls(this.ac, this.trim, this.state, this.telemetry.air, last.ap, DT);
        if (last) return last.controls;
      }
      return this.pilotControls();
    }
    if ("controls" in cmd) return clampControls(this.ac, cmd.controls);
    return this.ap.controls(this.ac, this.trim, this.state, this.telemetry.air, cmd.ap, DT);
  }

  private measure(u: Controls, gust: V3): Telemetry {
    const { air } = derivative(this.ac, this.state, u, gust);
    return {
      t: this.t,
      state: this.state,
      air,
      controls: u,
      euler: eulerFromQuat(this.state.q),
      alt: altitude(this.state),
      climb: climbRate(this.state),
      fPilot: specificForceAt(air, this.state.w, this.ac.pilot),
      w: this.state.w,
      cue: this.telemetry?.cue ?? { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 },
      crashed: altitude(this.state) <= 0,
      done: this.t >= this.scenario.duration,
    };
  }

  /** One fixed 100 Hz step. */
  tick(): Telemetry {
    if (this.telemetry.crashed) return this.telemetry;
    const u = (this.surfaces = actuate(this.ac, this.surfaces, this.controlsNow(), DT));
    const gust = this.turb.step(this.telemetry.air.Va, DT);
    this.state = step(this.ac, this.state, u, DT, gust);
    this.t += DT;
    const tel = this.measure(u, gust);
    tel.cue = this.washout.step(tel.fPilot, tel.w, DT);
    this.telemetry = tel;
    return tel;
  }

  /**
   * Advance by wall-clock time (any frame rate), in whole fixed steps; returns every step's
   * telemetry. Large gaps (a background tab) are capped so the sim doesn't race to catch up.
   */
  advance(seconds: number): Telemetry[] {
    this.accum = Math.min(this.accum + seconds, 0.25);
    const out: Telemetry[] = [];
    while (this.accum >= DT) {
      this.accum -= DT;
      out.push(this.tick());
    }
    return out;
  }
}
