import { useEffect, useRef, useSyncExternalStore } from "react";
import { DEFAULT_WASHOUT, G0, SCENARIOS, TURBULENCE_LEVELS, type TurbulenceLevel, type WashoutParams } from "@stewart/flight";
import { CueChart } from "./CueChart.tsx";
import { flight } from "./controller.ts";

const DEG = 180 / Math.PI;
const KT = 1.943844;
const FT = 3.28084;

const GAINS: { k: keyof WashoutParams; label: string; min: number; max: number; step: number; unit: string; deg?: boolean }[] = [
  { k: "transGain", label: "Surge / sway gain", min: 0, max: 1, step: 0.05, unit: "" },
  { k: "heaveGain", label: "Heave gain", min: 0, max: 0.5, step: 0.01, unit: "" },
  { k: "tiltGain", label: "Tilt coordination gain", min: 0, max: 1, step: 0.05, unit: "" },
  { k: "tiltRateMax", label: "Tilt rate limit", min: 1, max: 10, step: 0.5, unit: "°/s", deg: true },
  { k: "rotGain", label: "Rotation gain", min: 0, max: 2, step: 0.05, unit: "" },
  { k: "rotWn", label: "Rotation washout", min: 0.3, max: 4, step: 0.1, unit: "rad/s" },
];

function Attitude({ bank, pitch }: { bank: number; pitch: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const s = c.clientWidth;
    c.width = c.height = Math.round(s * dpr);
    const ctx = c.getContext("2d")!;
    const css = getComputedStyle(c);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s / 2 - 1, 0, 2 * Math.PI);
    ctx.clip();
    ctx.translate(s / 2, s / 2);
    ctx.rotate(-bank);
    const off = (pitch * DEG * s) / 60; // 30° of pitch to the edge
    ctx.fillStyle = css.getPropertyValue("--sky");
    ctx.fillRect(-s, -2 * s + off, 2 * s, 2 * s);
    ctx.fillStyle = css.getPropertyValue("--ground");
    ctx.fillRect(-s, off, 2 * s, 2 * s);
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.lineWidth = 1;
    for (const p of [-20, -10, 10, 20]) {
      const y = off - (p * s) / 60;
      ctx.beginPath();
      ctx.moveTo(-s / 8, y);
      ctx.lineTo(s / 8, y);
      ctx.stroke();
    }
    ctx.restore();
    // Fixed aircraft symbol.
    ctx.strokeStyle = css.getPropertyValue("--warn");
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(s * 0.22, s / 2);
    ctx.lineTo(s * 0.42, s / 2);
    ctx.lineTo(s / 2, s * 0.56);
    ctx.lineTo(s * 0.58, s / 2);
    ctx.lineTo(s * 0.78, s / 2);
    ctx.stroke();
  }, [bank, pitch]);
  return <canvas ref={ref} className="attitude" role="img" aria-label={`Bank ${(bank * DEG).toFixed(0)}°, pitch ${(pitch * DEG).toFixed(0)}°`} />;
}

export function FlightPanel() {
  const st = useSyncExternalStore((fn) => flight.subscribe(fn), () => flight.status);
  const { tel, scenario } = st;
  const free = scenario.id === "free";
  const nz = -tel.fPilot[2] / G0;

  // Never leave a loop driving the pose after the panel goes away.
  useEffect(() => () => flight.pause(), []);

  const setGain = (k: keyof WashoutParams, v: number) => flight.setParams({ ...st.params, [k]: v });

  return (
    <div className="flight">
      <p className="hint">
        A light aircraft flight model drives the platform through classical washout motion cueing. Every pose goes through the rig's
        limit checks first, so live hardware control can follow a flight like it follows the sliders.
      </p>

      <div className="flight-row">
        <label htmlFor="flight-scenario">Scenario</label>
        <select
          id="flight-scenario"
          value={scenario.id}
          onChange={(e) => {
            flight.pause();
            flight.reset(SCENARIOS.find((s) => s.id === e.target.value)!);
          }}
        >
          {SCENARIOS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <label htmlFor="flight-turb">Turbulence</label>
        <select id="flight-turb" value={st.turbulence} onChange={(e) => flight.setTurbulence(e.target.value as TurbulenceLevel)}>
          {Object.keys(TURBULENCE_LEVELS).map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>
      <p className="hint">{scenario.description}</p>

      <div className="actions flight-actions">
        {st.running ? (
          <button type="button" onClick={() => flight.pause()}>
            Pause
          </button>
        ) : (
          <button type="button" className="primary" onClick={() => flight.start()}>
            {tel.t > 0 && !tel.crashed ? "Resume" : "Fly"}
          </button>
        )}
        <button type="button" className="ghost" onClick={() => flight.stop()}>
          Reset
        </button>
        <span className="readout">t {tel.t.toFixed(1)} s</span>
      </div>
      {free && (
        <p className="hint">
          Arrows: pitch and roll · A / D: rudder · W / S: throttle · Space: pause.{" "}
          {st.gamepad ? `Gamepad: ${st.gamepad.slice(0, 40)}` : "A gamepad works too (press a button so the browser sees it)."}
        </p>
      )}
      {tel.crashed && <p className="hw-warn">The aircraft hit the ground. Reset to fly again.</p>}
      {!free && tel.done && <p className="hint">Scripted part done; the autopilot holds the last target.</p>}

      <div className="flight-instruments">
        <Attitude bank={tel.euler[0]} pitch={tel.euler[1]} />
        <dl className="flight-readouts">
          <dt>Airspeed</dt>
          <dd>{(tel.air.Va * KT).toFixed(0)} kt</dd>
          <dt>Altitude</dt>
          <dd>{(tel.alt * FT).toFixed(0)} ft</dd>
          <dt>Climb</dt>
          <dd>{(tel.climb * FT * 60).toFixed(0)} ft/min</dd>
          <dt>Bank / pitch</dt>
          <dd>
            {(tel.euler[0] * DEG).toFixed(0)}° / {(tel.euler[1] * DEG).toFixed(1)}°
          </dd>
          <dt>Load factor</dt>
          <dd>{nz.toFixed(2)} g</dd>
          <dt>Throttle</dt>
          <dd>{(tel.controls.throttle * 100).toFixed(0)} %</dd>
        </dl>
      </div>
      <p className={`flight-limit ${st.scale < 0.999 ? "clipped" : ""}`}>
        Limiter: {st.scale < 0.999 ? `cue scaled to ${(st.scale * 100).toFixed(0)} % to stay in reach` : "cue within reach"} ·{" "}
        {(st.clipShare * 100).toFixed(0)} % of the last 3 s scaled
      </p>

      <h3 className="subhead">What the pilot feels vs what the rider gets</h3>
      <p className="hint">
        Rig axes (x front, y left, z up). Specific force is what an accelerometer reads; heave has 1 g removed. The platform can't
        sustain acceleration, so it cues onsets and fakes steady pushes by tilting.
      </p>
      <CueChart title="Surge force" unit="m/s²" channel={0} history={flight.history} minSpan={0.5} />
      <CueChart title="Sway force" unit="m/s²" channel={1} history={flight.history} minSpan={0.5} />
      <CueChart title="Heave force" unit="m/s²" channel={2} history={flight.history} minSpan={0.5} />
      <CueChart title="Roll rate" unit="°/s" channel={3} history={flight.history} minSpan={2} />

      <h3 className="subhead">Washout tuning</h3>
      {GAINS.map(({ k, label, min, max, step, unit, deg }) => {
        const f = deg ? DEG : 1;
        const v = st.params[k] * f;
        return (
          <div className="slider" key={k}>
            <label htmlFor={`wo-${k}`}>{label}</label>
            <output htmlFor={`wo-${k}`}>
              {v.toFixed(step < 0.1 ? 2 : 1)}
              <span className="unit">{unit}</span>
            </output>
            <input id={`wo-${k}`} type="range" min={min} max={max} step={step} value={v} onChange={(e) => setGain(k, Number(e.target.value) / f)} />
          </div>
        );
      })}
      <div className="actions">
        <button type="button" className="ghost" onClick={() => flight.setParams(DEFAULT_WASHOUT)}>
          Default gains
        </button>
      </div>

      <h3 className="subhead">Aircraft modes at the start trim</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Mode</th>
              <th className="num">Period / τ</th>
              <th className="num">Damping ζ</th>
            </tr>
          </thead>
          <tbody>
            {st.modes.map((m) => (
              <tr key={m.name}>
                <td>{m.name}</td>
                <td className="num">{m.period !== undefined ? `${m.period.toFixed(1)} s` : `τ ${m.tau!.toFixed(2)} s`}</td>
                <td className="num">{m.zeta !== undefined ? m.zeta.toFixed(2) : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">
        From the eigenvalues of the model linearised about level flight at {(scenario.startSpeed * KT).toFixed(0)} kt. The tests check the
        non-linear simulation against these predictions.
      </p>
    </div>
  );
}
