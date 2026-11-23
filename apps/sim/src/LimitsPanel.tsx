import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { servoLabel } from "@stewart/rig-config";
import { ARDUINO_VENDOR_IDS } from "./hardware/link.ts";
import type { JogPhase } from "./hardware/jog.ts";
import {
  CAUSE_LABEL, CAUSE_SHORT, DEFAULT_MARGINS, FAULT_TEXT, PARAMS, fitLimits, markLogJson, parseMarkLog,
  type LimitMark, type MarkCause, type MarkKind, type MarkResult,
} from "./hardware/limitfit.ts";
import { jog, live, serial } from "./hardware/session.ts";
import { useSim } from "./store.ts";

const PHASE_LABEL: Record<JogPhase, string> = {
  disconnected: "Not connected",
  connecting: "Connecting…",
  unknown: "Connected · position unknown",
  ready: "Ready · holding",
  moving: "Moving…",
  busy: "Working…",
};
/** Reuse the Hardware panel's status-dot colours. */
const DOT: Record<JogPhase, string> = {
  disconnected: "disconnected", connecting: "connecting", unknown: "unknown", ready: "held", moving: "live", busy: "busy",
};

const STORAGE_KEY = "stewart.limitMarks.v1";
const KIND_LABEL: Record<MarkKind, string> = { max: "Upper stop", min: "Lower stop", level: "Level", clear: "Clear" };

function loadMarks(): LimitMark[] {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return text ? parseMarkLog(text) : [];
  } catch {
    return [];
  }
}

const fmt = (v: number, d = 1) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** One line on what the model makes of a marked contact or clear sweep. */
function verdict(r: MarkResult): string {
  if (r.sweep) {
    const end = r.alphaDeg && r.leg >= 0 ? `${fmt(r.alphaDeg[r.leg]!)}°` : "here";
    const { stoppedAt, noPoseFrom } = r.sweep;
    const stop = stoppedAt ? ` The software would have stopped it at ${fmt(stoppedAt.deg)}° (${stoppedAt.why}).` : " The software allows the whole sweep.";
    const gap = noPoseFrom !== null && stoppedAt?.why !== "the model has no pose"
      ? ` The model has no pose past ${fmt(noPoseFrom)}°, so it can't check the joints beyond that.`
      : noPoseFrom !== null ? " Joints past there can't be checked." : "";
    return `Clear from 0° to ${end}.${stop}${gap}`;
  }
  if (r.problem) return r.problem;
  if (!r.measure || r.overshoot === null) return "";
  const info = PARAMS[r.measure.param];
  const u = info.unit === "mm" ? " mm" : "°";
  const at = `${fmt(r.measure.value)}${u}`;
  const by = `${fmt(Math.abs(r.overshoot))}${u}`;
  if (Math.abs(r.overshoot) < 0.05) return `Contact at ${at}: the model's limit is right here.`;
  return r.overshoot > 0
    ? `Contact at ${at}: the software would let it go ${by} further, into the obstacle.`
    : `Contact at ${at}: the software stops ${by} short of it.`;
}

export function LimitsPanel() {
  const st = useSyncExternalStore((fn) => jog.subscribe(fn), () => jog.status);
  const livePhase = useSyncExternalStore((fn) => live.subscribe(fn), () => live.status.phase);
  const rig = useSim((s) => s.rig);
  const loadRig = useSim((s) => s.loadRig);
  const [selected, setSelected] = useState(0);
  const [cause, setCause] = useState<MarkCause | "">("");
  const [note, setNote] = useState("");
  const [marks, setMarks] = useState<LimitMark[]>(loadMarks);
  const [margins, setMargins] = useState(DEFAULT_MARGINS);
  const [logMsg, setLogMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, markLogJson(marks));
  }, [marks]);

  // Esc stops; hiding the tab stops too (background tabs throttle timers).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void jog.stop();
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") void jog.stop();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, []);

  const fit = useMemo(() => fitLimits(rig, marks, margins), [rig, marks, margins]);
  const resultById = useMemo(() => new Map(fit.results.map((r) => [r.mark.id, r])), [fit]);
  const willChange = fit.suggestions.some((s) => s.change !== "same") || fit.trims.some((t) => t.suggested !== t.current);

  const connect = async () => {
    try {
      const port = await serial!.requestPort({ filters: ARDUINO_VENDOR_IDS.map((usbVendorId) => ({ usbVendorId })) });
      await jog.connect(port);
    } catch {
      /* chooser cancelled */
    }
  };

  const addMark = (kind: MarkKind) => {
    if (!st.usByChannel) return;
    const s = rig.servos[selected]!;
    const mark: LimitMark = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      time: new Date().toISOString(),
      rigName: rig.name,
      channel: s.channel,
      label: servoLabel(rig, selected),
      kind,
      ...(kind !== "level" && cause ? { cause } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      usByChannel: [...st.usByChannel],
    };
    setMarks((m) => [...m, mark]);
    setCause("");
    setNote("");
  };

  const importLog = async (file: File | undefined) => {
    if (!file) return;
    try {
      const incoming = parseMarkLog(await file.text());
      setMarks((m) => {
        const have = new Set(m.map((x) => x.id));
        return [...m, ...incoming.filter((x) => !have.has(x.id))];
      });
      setLogMsg({ text: `Imported ${incoming.length} marks from ${file.name}.`, bad: false });
    } catch (e) {
      setLogMsg({ text: `Could not import ${file.name}: ${(e as Error).message}`, bad: true });
    }
    if (fileInput.current) fileInput.current.value = "";
  };

  const copyRig = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(fit.rig, null, 2) + "\n");
      setLogMsg({ text: "Copied the suggested rig.json. Paste it over packages/rig-config/rig.json to keep it.", bad: false });
    } catch {
      setLogMsg({ text: "Clipboard blocked by the browser.", bad: true });
    }
  };

  const order = rig.servos.map((_, i) => i).sort((a, b) => servoLabel(rig, a) - servoLabel(rig, b));
  const active = st.phase === "ready" || st.phase === "moving";
  const connected = st.phase !== "disconnected" && st.phase !== "connecting";
  const maxSpeed = jog.maxSpeed();
  const a = st.alphaDeg;

  return (
    <div className="hw">
      <p className="hint">
        Move one servo at a time with its slider until something on the rig stops it, then mark that spot. The log below turns the marks into rig.json limits.
      </p>
      {serial ? (
        <div className="hw-state">
          <span className={`hw-dot ${DOT[st.phase]}`} aria-hidden />
          <span>{PHASE_LABEL[st.phase]}</span>
        </div>
      ) : (
        <p className="hint">Jogging needs Web Serial (desktop Chrome or Edge). The log and the fit below still work.</p>
      )}

      {serial && st.phase === "disconnected" && (
        <>
          {livePhase !== "disconnected" && <p className="hw-warn">The Hardware panel is connected to the Uno. Disconnect it there first.</p>}
          <div className="actions tight">
            <button type="button" className="primary" onClick={() => void connect()} disabled={livePhase !== "disconnected"}>
              Connect to Uno…
            </button>
          </div>
        </>
      )}

      {st.phase === "unknown" && (
        <>
          <p className="notice warn">
            <strong>Level horns</strong> moves every servo to 0° at once, each at its own full speed. Keep hands clear.
          </p>
          <div className="actions tight">
            <button type="button" className="primary" onClick={() => void jog.level()} disabled={!maxSpeed}>
              Level horns
            </button>
          </div>
        </>
      )}

      {active && a && (
        <>
          {st.phase === "moving" && (
            <button type="button" className="stop" onClick={() => void jog.stop()}>
              Stop <kbd>Esc</kbd>
            </button>
          )}

          {!st.pose && <p className="hw-warn">The model has no pose for these horn angles (the geometry in rig.json can't be built this way).</p>}
          <div className="jog-sliders">
            {order.map((i) => {
              // Firmware window rounded inward to the 0.2° step, so the slider lands on 0° exactly.
              const [wlo, whi] = jog.windowDeg(i);
              const lo = Math.ceil(wlo * 5) / 5, hi = Math.floor(whi * 5) / 5;
              const pct = (v: number) => ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * 100;
              const smin = pct(rig.limits.servoMinDeg), smax = pct(rig.limits.servoMaxDeg);
              const band = `linear-gradient(to right, var(--track) ${smin}%, var(--reach) ${smin}%, var(--reach) ${smax}%, var(--track) ${smax}%)`;
              const t = st.target?.[i] ?? a[i]!;
              const faults = st.faults?.[i] ?? [];
              const label = servoLabel(rig, i);
              return (
                <div key={i} className={`slider jog-row${i === selected ? " on" : ""}`} onFocus={() => setSelected(i)} onPointerDown={() => setSelected(i)}>
                  <label htmlFor={`jog-${i}`}>
                    Servo {label}
                    {faults.map((f) => (
                      <span key={f} className="chip bad">
                        {FAULT_TEXT[f]}
                      </span>
                    ))}
                  </label>
                  <output htmlFor={`jog-${i}`} className={faults.length ? "over" : undefined}>
                    {fmt(a[i]!)}
                    <span className="unit">°</span>
                    {Math.abs(t - a[i]!) > 0.05 && <span className="unit"> → {fmt(t)}°</span>}
                  </output>
                  <input
                    id={`jog-${i}`}
                    type="range"
                    min={lo}
                    max={hi}
                    step={0.2}
                    value={t}
                    style={{ background: band }}
                    aria-label={`Servo ${label} horn angle`}
                    onChange={(e) => jog.setAngle(i, Number(e.target.value))}
                  />
                </div>
              );
            })}
          </div>
          <p className="hint">
            Right raises the horn's rod end. The shaded part of each track is the servo range in rig.json. The servo follows the slider at the jog speed. For
            fine moves near a stop, click a slider and use the arrow keys (0.2° each), and stop at first contact: an MG996R pushing on a hard stop can strip its gears.
          </p>

          <div className="slider">
            <label htmlFor="jog-speed">Jog speed</label>
            <output htmlFor="jog-speed">
              {Math.round(st.speed)}
              <span className="unit">°/s</span>
            </output>
            <input id="jog-speed" type="range" min={2} max={maxSpeed} step={1} value={st.speed} onChange={(e) => jog.setSpeed(Number(e.target.value))} />
          </div>

          <label className="jog-check">
            <input type="checkbox" checked={st.beyond} onChange={(e) => jog.setBeyond(e.target.checked)} />
            <span>
              Go past software limits
              <span className="hint"> · the model's limits become readouts; only the firmware's 500–2500 µs window still applies.</span>
            </span>
          </label>
          {st.stoppedBy && <p className="hw-warn">Stopped short: {st.stoppedBy}</p>}

          <h3 className="subhead">Mark this position</h3>
          <select className="jog-select" value={cause} onChange={(e) => setCause(e.target.value as MarkCause | "")} aria-label="What stopped the servo">
            <option value="">What stopped servo {servoLabel(rig, selected)}?</option>
            {(Object.keys(CAUSE_LABEL) as MarkCause[]).map((c) => (
              <option key={c} value={c}>
                {CAUSE_LABEL[c]}
              </option>
            ))}
          </select>
          <input className="jog-note" type="text" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
          <div className="actions tight">
            <button type="button" onClick={() => addMark("max")} disabled={st.phase !== "ready" || !cause}>
              ▲ Upper stop
            </button>
            <button type="button" onClick={() => addMark("min")} disabled={st.phase !== "ready" || !cause}>
              ▼ Lower stop
            </button>
            <button type="button" onClick={() => addMark("level")} disabled={st.phase !== "ready"}>
              Horn is level
            </button>
            <button type="button" onClick={() => addMark("clear")} disabled={st.phase !== "ready"}>
              Clear to here
            </button>
          </div>
          <p className="hint">
            "Clear to here" means this servo swept from 0° to here, with the other servos where they are now, and nothing touched. The fit loosens any limit
            that would have stopped that sweep. No cause needed.
          </p>
          <p className="hint">
            "Horn is level" records this servo's true level (its trimUs), so angles are measured from where the horn really sits flat. Mark it first if 0° doesn't look level.
          </p>
        </>
      )}

      {st.message && <p className={st.message.bad ? "hw-error" : "hint"} role={st.message.bad ? "alert" : undefined}>{st.message.text}</p>}

      {connected && (
        <div className="actions tight">
          {active && (
            <button type="button" onClick={() => jog.home()}>
              Ramp all to level
            </button>
          )}
          <button type="button" onClick={() => void jog.release()} disabled={st.phase === "busy"}>
            Release (limp)
          </button>
          <button type="button" className="ghost" onClick={() => void jog.disconnect()} disabled={st.phase === "busy"}>
            Disconnect
          </button>
        </div>
      )}

      <h3 className="subhead">Log · {marks.length} marks</h3>
      {marks.length === 0 ? (
        <p className="hint">No marks yet. They are kept in this browser until you clear them; export to keep a copy in the repo.</p>
      ) : (
        <div className="table-wrap">
          <table className="marks">
            <thead>
              <tr>
                <th>Servo</th>
                <th>Mark</th>
                <th className="num">Horn</th>
                <th>Model</th>
                <th aria-label="Delete" />
              </tr>
            </thead>
            <tbody>
              {marks.map((m) => {
                const r = resultById.get(m.id);
                const trim = fit.trims.find((t) => rig.servos[t.leg]?.channel === m.channel);
                const deg = r?.alphaDeg && r.leg >= 0 ? r.alphaDeg[r.leg]! : null;
                return (
                  <tr key={m.id}>
                    <td>{m.label}</td>
                    <td>
                      {KIND_LABEL[m.kind]}
                      {m.cause && <span className="sub">{CAUSE_SHORT[m.cause]}</span>}
                      {m.note && <span className="sub">“{m.note}”</span>}
                    </td>
                    <td className="num">{m.kind === "level" ? `${m.usByChannel[m.channel]} µs` : deg === null ? "–" : `${fmt(deg)}°`}</td>
                    <td className="sub-cell">
                      {m.kind === "level" ? (trim ? `trimUs ${trim.suggested}` : "") : r ? verdict(r) : ""}
                    </td>
                    <td>
                      <button type="button" className="ghost icon" aria-label="Delete mark" onClick={() => setMarks((all) => all.filter((x) => x.id !== m.id))}>
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(fit.suggestions.length > 0 || fit.trims.length > 0) && (
        <>
          <h3 className="subhead">Suggested rig.json</h3>
          <div className="jog-margins">
            <label>
              Margin
              <input type="number" min={0} max={10} step={0.5} value={margins.deg} onChange={(e) => setMargins({ ...margins, deg: Math.max(0, Number(e.target.value)) })} />°
            </label>
            <label>
              <input type="number" min={0} max={5} step={0.1} value={margins.mm} onChange={(e) => setMargins({ ...margins, mm: Math.max(0, Number(e.target.value)) })} />
              mm
            </label>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Limit</th>
                  <th className="num">Now</th>
                  <th className="num">Measured</th>
                  <th className="num">New</th>
                </tr>
              </thead>
              <tbody>
                {fit.suggestions.map((s) => {
                  const u = PARAMS[s.param].unit === "mm" ? " mm" : "°";
                  return (
                    <tr key={s.param}>
                      <td>
                        {PARAMS[s.param].label}
                        <span className="sub">
                          {s.marks} {s.source === "clear" ? "clear sweep" : "mark"}{s.marks > 1 ? "s" : ""} on {s.servos} servo{s.servos > 1 ? "s" : ""}
                          {s.change !== "same" && ` · ${s.change}`}
                        </span>
                        {s.warn && <span className="sub warn-text">{s.warn}</span>}
                      </td>
                      <td className="num">{fmt(s.current)}{u}</td>
                      <td className="num">{fmt(s.measured)}{u}</td>
                      <td className="num">
                        <strong>{fmt(s.suggested)}{u}</strong>
                      </td>
                    </tr>
                  );
                })}
                {fit.trims.map((t) => (
                  <tr key={`trim-${t.leg}`}>
                    <td>Servo {t.label} trimUs</td>
                    <td className="num">{t.current}</td>
                    <td className="num">–</td>
                    <td className="num">
                      <strong>{t.suggested}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">
            Measured is the most restrictive contact for that limit, as the model measures it at the marked horn angles; New = that less the margin. For
            limits set only by clear sweeps, Measured is the furthest the sweeps went and New allows exactly that.
            {fit.trims.length > 0 && " Trims are applied first, so every angle above is measured from the marked level."}
          </p>
        </>
      )}

      <div className="actions tight">
        {willChange && (
          <button type="button" className="primary" onClick={() => loadRig(fit.rig)} disabled={active}>
            Apply to sim
          </button>
        )}
        {willChange && (
          <button type="button" onClick={() => void copyRig()}>
            Copy rig.json
          </button>
        )}
        <button type="button" onClick={() => download(`limit-marks-${new Date().toISOString().slice(0, 10)}.json`, markLogJson(marks))} disabled={!marks.length}>
          Export log
        </button>
        <button type="button" onClick={() => fileInput.current?.click()}>
          Import log…
        </button>
        <button
          type="button"
          className="ghost"
          disabled={!marks.length}
          onClick={() => {
            if (window.confirm(`Delete all ${marks.length} marks from this browser? Export first if you want to keep them.`)) setMarks([]);
          }}
        >
          Clear
        </button>
      </div>
      {willChange && active && <p className="hint">Apply is off while servos are powered: new trims would shift every horn. Release or disconnect first.</p>}
      <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => void importLog(e.target.files?.[0])} />
      {logMsg && <p className={logMsg.bad ? "hw-error" : "hint"}>{logMsg.text}</p>}
    </div>
  );
}
