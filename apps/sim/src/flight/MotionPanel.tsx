import { DEFAULT_WASHOUT, type WashoutParams } from "@stewart/flight";
import { CueChart } from "./CueChart.tsx";
import { flight } from "./controller.ts";
import { useFlight } from "./useFlight.ts";

const DEG = 180 / Math.PI;

const GAINS: { k: keyof WashoutParams; label: string; min: number; max: number; step: number; unit: string; deg?: boolean }[] = [
  { k: "rotGain", label: "Rotation gain", min: 0, max: 2, step: 0.05, unit: "" },
  { k: "rotWn", label: "Rotation washout", min: 0.3, max: 4, step: 0.1, unit: "rad/s" },
  { k: "tiltGain", label: "Tilt gain", min: 0, max: 1, step: 0.05, unit: "" },
  { k: "tiltMax", label: "Max tilt", min: 2, max: 15, step: 0.5, unit: "°", deg: true },
  { k: "tiltRateMax", label: "Tilt rate", min: 1, max: 10, step: 0.5, unit: "°/s", deg: true },
  { k: "transGain", label: "Surge / sway gain", min: 0, max: 1, step: 0.05, unit: "" },
  { k: "heaveGain", label: "Heave gain", min: 0, max: 0.5, step: 0.01, unit: "" },
];

/** Motion cueing drawer: aircraft vs platform cues, washout tuning, aircraft modes. */
export function MotionPanel() {
  const st = useFlight((s) => s);
  const setGain = (k: keyof WashoutParams, v: number) => flight.setParams({ ...st.params, [k]: v });
  const scaled = st.scale < 0.999;
  return (
    <div className="mp">
      <dl className="mp-stats">
        <div>
          <dt>Cue</dt>
          <dd className={scaled ? "warn" : undefined}>{scaled ? `${(st.scale * 100).toFixed(0)}%` : "Full"}</dd>
        </div>
        <div>
          <dt>Scaled, last 3 s</dt>
          <dd>{(st.clipShare * 100).toFixed(0)}%</dd>
        </div>
      </dl>

      <CueChart title="Surge" unit="m/s²" channel={0} history={flight.history} minSpan={0.5} />
      <CueChart title="Sway" unit="m/s²" channel={1} history={flight.history} minSpan={0.5} />
      <CueChart title="Heave" unit="m/s²" channel={2} history={flight.history} minSpan={0.5} />
      <CueChart title="Roll rate" unit="°/s" channel={3} history={flight.history} minSpan={2} />

      <header className="mp-head">
        <h3 className="subhead">Tuning</h3>
        <button type="button" className="ghost" onClick={() => flight.setParams(DEFAULT_WASHOUT)}>
          Reset
        </button>
      </header>
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

      <h3 className="subhead">Aircraft modes</h3>
      <table className="mp-modes">
        <tbody>
          {st.modes.map((m) => (
            <tr key={m.name}>
              <td>{m.name}</td>
              <td className="num">{m.period !== undefined ? `${m.period.toFixed(1)} s` : `τ ${m.tau!.toFixed(2)} s`}</td>
              <td className="num">{m.zeta !== undefined ? `ζ ${m.zeta.toFixed(2)}` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
