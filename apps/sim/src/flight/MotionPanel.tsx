import { DEFAULT_WASHOUT, type WashoutParams } from "@stewart/flight";
import { CueChart } from "./CueChart.tsx";
import { flight } from "./controller.ts";
import { useFlight } from "./useFlight.ts";

const DEG = 180 / Math.PI;
const KT = 1.943844;

const GAINS: { k: keyof WashoutParams; label: string; min: number; max: number; step: number; unit: string; deg?: boolean }[] = [
  { k: "transGain", label: "Surge / sway gain", min: 0, max: 1, step: 0.05, unit: "" },
  { k: "heaveGain", label: "Heave gain", min: 0, max: 0.5, step: 0.01, unit: "" },
  { k: "tiltGain", label: "Tilt coordination gain", min: 0, max: 1, step: 0.05, unit: "" },
  { k: "tiltRateMax", label: "Tilt rate limit", min: 1, max: 10, step: 0.5, unit: "°/s", deg: true },
  { k: "rotGain", label: "Rotation gain", min: 0, max: 2, step: 0.05, unit: "" },
  { k: "rotWn", label: "Rotation washout", min: 0.3, max: 4, step: 0.1, unit: "rad/s" },
];

/** Motion cueing drawer: aircraft vs platform cue charts, washout gains, limiter, aircraft modes. */
export function MotionPanel() {
  const st = useFlight((s) => s);
  const setGain = (k: keyof WashoutParams, v: number) => flight.setParams({ ...st.params, [k]: v });
  return (
    <div className="flight">
      <p className="hint">
        Classical washout turns the aircraft's motion into platform poses: onsets become real platform motion that drifts back to centre,
        steady pushes become a slow tilt. Rig axes (x front, y left, z up); specific force is what an accelerometer reads, heave with 1 g removed.
      </p>
      <p className={`flight-limit ${st.scale < 0.999 ? "clipped" : ""}`}>
        Limiter: {st.scale < 0.999 ? `cue scaled to ${(st.scale * 100).toFixed(0)} % to stay in reach` : "cue within reach"} ·{" "}
        {(st.clipShare * 100).toFixed(0)} % of the last 3 s scaled
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
        From the eigenvalues of the model linearised about level flight at {(st.scenario.startSpeed * KT).toFixed(0)} kt. The tests check the
        non-linear simulation against these predictions.
      </p>
    </div>
  );
}
