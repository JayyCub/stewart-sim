import { useRef, useState, type ReactNode } from "react";
import type { Axis, LegFault, Limits } from "@stewart/kinematics";
import { parseRigJson } from "@stewart/rig-config";
import { GEO, geoValue } from "./params.ts";
import { RigView } from "./RigView.tsx";
import { SweepPanel } from "./SweepPanel.tsx";
import { TemplatePanel } from "./TemplatePanel.tsx";
import { TiltMapView } from "./TiltMapView.tsx";
import { DEG, exportRigJson, useSim } from "./store.ts";

/** Fixed decimals without a "-0.0" for values that round to zero. */
const fmt = (v: number, d = 1) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);

const FAULT_LABEL: Record<LegFault, string> = {
  "no-solution": "Out of reach",
  "servo-range": "Servo limit",
  "ball-swivel-bottom": "Lower ball joint",
  "ball-swivel-top": "Upper ball joint",
  "servo-clash": "Servo bodies clash",
  "rod-hits-servo": "Rod hits a servo",
  "rod-hits-horn": "Rod hits horn",
};

interface SliderProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
  /** Reachable span [lo, hi] in slider units, drawn on the track. */
  band?: [number, number];
}

function Slider({ id, label, value, min, max, step, unit, onChange, band }: SliderProps) {
  const pct = (v: number) => ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 100;
  const style = band
    ? { background: `linear-gradient(to right, var(--track) ${pct(band[0])}%, var(--reach) ${pct(band[0])}%, var(--reach) ${pct(band[1])}%, var(--track) ${pct(band[1])}%)` }
    : undefined;
  const outside = band && (value < band[0] - 1e-9 || value > band[1] + 1e-9);
  return (
    <div className="slider">
      <label htmlFor={id}>{label}</label>
      <output htmlFor={id} className={outside ? "over" : undefined}>
        {fmt(value, step < 1 ? 1 : 0)}
        <span className="unit">{unit}</span>
      </output>
      <input id={id} type="range" min={min} max={max} step={step} value={value} style={style} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel-section">
      <header>
        <h2>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

const POSE_AXES: { k: Axis; label: string; unit: "mm" | "°"; range: number }[] = [
  { k: "x", label: "Surge x", unit: "mm", range: 50 },
  { k: "y", label: "Sway y", unit: "mm", range: 50 },
  { k: "z", label: "Heave z", unit: "mm", range: 40 },
  { k: "roll", label: "Roll", unit: "°", range: 35 },
  { k: "pitch", label: "Pitch", unit: "°", range: 35 },
  { k: "yaw", label: "Yaw", unit: "°", range: 60 },
];


const LIM: { k: keyof Limits; label: string; unit: string; min: number; max: number; step: number }[] = [
  { k: "servoMinDeg", label: "Servo min", unit: "°", min: -90, max: 0, step: 1 },
  { k: "servoMaxDeg", label: "Servo max", unit: "°", min: 0, max: 90, step: 1 },
  { k: "ballSwivelDeg", label: "Ball joint swivel", unit: "°", min: 5, max: 60, step: 1 },
];

export function App() {
  const s = useSim();
  const [toast, setToast] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pasteBox = useRef<HTMLTextAreaElement>(null);
  const isAngle = (k: Axis) => k === "roll" || k === "pitch" || k === "yaw";
  const buildable = Number.isFinite(s.layout.homeHeight);
  const badLegs = s.solution.legs.filter((l) => l.faults.length > 0).length;

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2200);
  };

  /** Validate rig.json text and load it; on failure keep the current rig and show why. */
  const loadText = (text: string, source: string) => {
    try {
      const rig = parseRigJson(text);
      s.loadRig(rig);
      setLoadError(null);
      setPasteOpen(false);
      flash(`Loaded ${rig.name} from ${source}`);
    } catch (e) {
      setLoadError(`Could not load ${source}. The current rig is unchanged.\n${(e as Error).message}`);
    }
  };

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    loadText(await file.text(), file.name);
    if (fileInput.current) fileInput.current.value = "";
  };

  const copyJson = async () => {
    const text = exportRigJson(s);
    try {
      await navigator.clipboard.writeText(text);
      flash("Copied rig.json to the clipboard");
    } catch {
      const ta = document.getElementById("rig-json-fallback") as HTMLTextAreaElement | null;
      if (ta) {
        ta.value = text;
        ta.hidden = false;
        ta.select();
      }
      flash("Clipboard blocked. The JSON is selected below; copy it from there.");
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>Stewart Platform Sim</h1>
          <span className="meta">
            {s.rig.name} · 6 × MG996R · rotary legs
          </span>
        </div>
        <div className={`status ${!buildable ? "bad" : badLegs ? "bad" : "good"}`} role="status">
          {!buildable ? "Rods too short to reach the platform" : badLegs ? `${badLegs} of 6 legs over a limit` : "All legs within limits"}
        </div>
      </header>

      <main className="layout">
        <div className="viewport">
          <RigView />
          <div className="viewport-note">Drag to orbit · scroll to zoom · the notch on the top plate marks +x</div>
        </div>

        <aside className="controls">
          {!s.rig.measured && (
            <p className="notice">
              These are placeholder dimensions. Measure your servos, horns and ball joints (Phase 0), then update <code>rig.json</code>.
            </p>
          )}

          <Section
            title="Pose"
            aside={
              <button type="button" className="ghost" onClick={s.resetPose}>
                Home
              </button>
            }
          >
            <p className="hint">The shaded part of each track is how far that axis alone can move from home.</p>
            {POSE_AXES.map(({ k, label, unit, range }) => {
              const f = isAngle(k) ? 1 / DEG : 1;
              return (
                <Slider
                  key={k}
                  id={`pose-${k}`}
                  label={label}
                  unit={unit}
                  value={s.pose[k] * f}
                  min={-range}
                  max={range}
                  step={0.5}
                  band={[s.reach[k].min * f, s.reach[k].max * f]}
                  onChange={(v) => s.setPose(k, v / f)}
                />
              );
            })}
          </Section>

          <Section title="Legs">
            <div className="table-wrap">
              <table className="legs">
                <thead>
                  <tr>
                    <th>Leg</th>
                    <th>Ch</th>
                    <th className="num">Horn</th>
                    <th className="num">Swivel lo / hi</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {s.solution.legs.map((leg, i) => (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td>{s.rig.servos[i]?.channel ?? i}</td>
                      <td className="num">{Number.isNaN(leg.alpha) ? "–" : `${fmt(leg.alpha / DEG)}°`}</td>
                      <td className="num">
                        {Number.isNaN(leg.swivelBottom) ? "–" : `${(leg.swivelBottom / DEG).toFixed(0)}° / ${(leg.swivelTop / DEG).toFixed(0)}°`}
                      </td>
                      <td>
                        {leg.faults.length === 0 ? (
                          <span className="chip ok">OK</span>
                        ) : (
                          leg.faults.map((f) => (
                            <span key={f} className="chip bad">
                              {FAULT_LABEL[f]}
                            </span>
                          ))
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint">Horn angle is measured from level; positive raises the rod end.</p>
          </Section>

          <Section
            title="Geometry"
            aside={<span className="readout">Home height {buildable ? `${s.layout.homeHeight.toFixed(1)} mm` : "–"}</span>}
          >
            {GEO.filter((p) => !p.mount).map(({ k, label, unit, min, max, step }) => (
              <Slider key={k} id={`geo-${k}`} label={label} unit={unit} value={geoValue(s.geometry, k)} min={min} max={max} step={step} onChange={(v) => s.setGeometry(k, v)} />
            ))}
            <h3 className="subhead">Mount orientation</h3>
            <p className="hint">
              Servo turn equal to the pair half-spacing ({s.geometry.baseHalfAngleDeg}°) makes a pair's shafts parallel, so both servos sit side by
              side on one flat wall. Tilt angles point shafts and top studs outward-and-up (positive) or outward-and-down.
            </p>
            {GEO.filter((p) => p.mount).map(({ k, label, unit, min, max, step }) => (
              <Slider key={k} id={`geo-${k}`} label={label} unit={unit} value={geoValue(s.geometry, k)} min={min} max={max} step={step} onChange={(v) => s.setGeometry(k, v)} />
            ))}
          </Section>

          <Section title="Limits">
            {LIM.map(({ k, label, unit, min, max, step }) => (
              <Slider key={k} id={`lim-${k}`} label={label} unit={unit} value={s.limits[k]} min={min} max={max} step={step} onChange={(v) => s.setLimit(k, v)} />
            ))}
          </Section>

          <Section title="Reach from home">
            <div className="table-wrap">
              <table className="reach">
                <thead>
                  <tr>
                    <th>Axis</th>
                    <th className="num">Min</th>
                    <th className="num">Max</th>
                  </tr>
                </thead>
                <tbody>
                  {POSE_AXES.map(({ k, label, unit }) => {
                    const f = isAngle(k) ? 1 / DEG : 1;
                    return (
                      <tr key={k}>
                        <td>{label}</td>
                        <td className="num">
                          {fmt(s.reach[k].min * f)} {unit}
                        </td>
                        <td className="num">
                          {fmt(s.reach[k].max * f)} {unit}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Roll × pitch reach">
            <TiltMapView />
          </Section>

          <Section title="Geometry sweep">
            <SweepPanel />
          </Section>

          <Section title="Drilling templates">
            <TemplatePanel onBlocked={flash} />
          </Section>

          <div className="actions">
            <button type="button" className="primary" onClick={copyJson}>
              Copy rig.json
            </button>
            <button type="button" onClick={() => fileInput.current?.click()}>
              Load rig.json…
            </button>
            <button type="button" onClick={() => setPasteOpen((o) => !o)} aria-expanded={pasteOpen}>
              Paste rig.json
            </button>
            <button type="button" className="ghost" onClick={s.resetRig}>
              Reset to loaded rig
            </button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => void loadFile(e.target.files?.[0])}
          />
          {pasteOpen && (
            <div className="paste-box">
              <textarea ref={pasteBox} className="json-fallback" rows={10} aria-label="Paste rig.json" placeholder="Paste the contents of rig.json here" autoFocus />
              <div className="actions">
                <button type="button" className="primary" onClick={() => loadText(pasteBox.current?.value ?? "", "pasted text")}>
                  Load
                </button>
                <button type="button" className="ghost" onClick={() => setPasteOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {loadError && (
            <pre className="load-error" role="alert">
              {loadError}
            </pre>
          )}
          <textarea id="rig-json-fallback" className="json-fallback" rows={10} readOnly hidden aria-label="rig.json" />
        </aside>
      </main>

      <div className={`toast${toast ? " show" : ""}`} role="status" aria-live="polite">
        {toast}
      </div>
    </div>
  );
}
