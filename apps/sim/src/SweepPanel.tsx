import { useEffect, useMemo, useRef, useState } from "react";
import { DEG, scoreGeometry, sweepSize, type Geometry, type SweepRange, type SweepResult } from "@stewart/kinematics";
import { GEO } from "./params.ts";
import { useSim } from "./store.ts";
import type { SweepMessage, SweepRequest } from "./sweep.worker.ts";

interface RangeRow {
  vary: boolean;
  min: number;
  max: number;
  steps: number;
}

/**
 * Starting ranges. Horn length and base radius stay fixed by default: the horn
 * has a few discrete holes, and the base radius is set by the plate you cut.
 * The rod range should stop at what the threaded rod and ball ends allow.
 */
const START: Record<keyof Geometry, RangeRow> = {
  baseRadius: { vary: false, min: 70, max: 110, steps: 5 },
  platformRadius: { vary: true, min: 40, max: 90, steps: 6 },
  baseHalfAngleDeg: { vary: true, min: 14, max: 30, steps: 5 },
  platformHalfAngleDeg: { vary: true, min: 5, max: 55, steps: 6 },
  hornLength: { vary: false, min: 16, max: 28, steps: 4 },
  rodLength: { vary: true, min: 100, max: 170, steps: 8 },
};

/** Sweeps above this many geometries take minutes; ask for fewer steps instead. */
const MAX_CANDIDATES = 40000;
const KEEP = 10;

const span = (r: SweepResult, k: keyof SweepResult["reach"], f = 1) => ((r.reach[k].max - r.reach[k].min) * f).toFixed(0);

export function SweepPanel() {
  const s = useSim();
  const [rows, setRows] = useState(START);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<SweepResult[]>([]);
  const [finished, setFinished] = useState(false);
  const worker = useRef<Worker | null>(null);

  useEffect(() => () => worker.current?.terminate(), []);

  const varied = GEO.filter(({ k }) => rows[k].vary);
  const ranges: SweepRange[] = varied.map(({ k }) => ({ key: k, min: rows[k].min, max: rows[k].max, steps: Math.max(1, Math.round(rows[k].steps)) }));
  const total = sweepSize(ranges);
  const invalid = ranges.some((r) => !(r.min <= r.max)) || varied.length === 0;
  const running = progress !== null && !finished;
  const current = useMemo(() => scoreGeometry(s.geometry, s.limits, s.rig.collision), [s.geometry, s.limits, s.rig.collision]);

  const setRow = (k: keyof Geometry, patch: Partial<RangeRow>) => setRows((r) => ({ ...r, [k]: { ...r[k], ...patch } }));

  const run = () => {
    worker.current?.terminate();
    const w = new Worker(new URL("./sweep.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    setResults([]);
    setFinished(false);
    setProgress({ done: 0, total });
    w.onmessage = (e: MessageEvent<SweepMessage>) => {
      setResults(e.data.best);
      if (e.data.type === "progress") setProgress({ done: e.data.done, total: e.data.total });
      else {
        setProgress({ done: e.data.total, total: e.data.total });
        setFinished(true);
        w.terminate();
      }
    };
    const req: SweepRequest = { base: s.geometry, ranges, limits: s.limits, collision: s.rig.collision, keep: KEEP };
    w.postMessage(req);
  };

  const cancel = () => {
    worker.current?.terminate();
    setFinished(true);
  };

  const isCurrent = (g: Geometry) => GEO.every(({ k }) => Math.abs(g[k] - s.geometry[k]) < 1e-9);

  return (
    <div className="sweep">
      <p className="hint">
        Tries every combination of the ticked ranges (others stay at their slider values) and ranks them by reach on all six axes,
        with collisions counted. Set the rod range to what your threaded rod and ball ends can actually make.
      </p>
      <div className="sweep-grid" role="group" aria-label="Sweep ranges">
        <span className="sweep-head" />
        <span className="sweep-head num">Min</span>
        <span className="sweep-head num">Max</span>
        <span className="sweep-head num">Steps</span>
        {GEO.map(({ k, label, unit }) => {
          const r = rows[k];
          return (
            <div className="sweep-row" key={k}>
              <label className="sweep-name">
                <input type="checkbox" checked={r.vary} disabled={running} onChange={(e) => setRow(k, { vary: e.target.checked })} />
                {label}
                <span className="unit">{unit}</span>
              </label>
              {r.vary ? (
                <>
                  <input type="number" aria-label={`${label} min`} value={r.min} step="any" disabled={running} onChange={(e) => setRow(k, { min: Number(e.target.value) })} />
                  <input type="number" aria-label={`${label} max`} value={r.max} step="any" disabled={running} onChange={(e) => setRow(k, { max: Number(e.target.value) })} />
                  <input type="number" aria-label={`${label} steps`} value={r.steps} min={1} step={1} disabled={running} onChange={(e) => setRow(k, { steps: Number(e.target.value) })} />
                </>
              ) : (
                <span className="sweep-fixed">fixed at {s.geometry[k]}</span>
              )}
            </div>
          );
        })}
      </div>

      <div className="actions">
        {running ? (
          <button type="button" onClick={cancel}>
            Cancel
          </button>
        ) : (
          <button type="button" className="primary" onClick={run} disabled={invalid || total > MAX_CANDIDATES}>
            Run sweep
          </button>
        )}
        <span className="readout">
          {total.toLocaleString()} layouts{total > MAX_CANDIDATES ? ` · over ${MAX_CANDIDATES.toLocaleString()}, use fewer steps` : ""}
        </span>
      </div>

      {progress && (
        <progress className="sweep-progress" value={progress.done} max={progress.total} aria-label="Sweep progress">
          {progress.done} of {progress.total}
        </progress>
      )}

      <p className="hint">
        Current layout scores <strong>{current.score.toFixed(2)}</strong>. 1.00 means every axis spans ±30 mm (heave ±20 mm), ±15° roll and pitch, ±30° yaw.
      </p>

      {results.length > 0 && (
        <div className="table-wrap">
          <table className="sweep-results">
            <thead>
              <tr>
                <th className="num">Score</th>
                {varied.map(({ k, label }) => (
                  <th key={k} className="num" title={label}>
                    {label.replace("half-spacing", "½°").replace(" radius", " r")}
                  </th>
                ))}
                <th className="num" title="Span of surge / sway / heave, mm">x/y/z mm</th>
                <th className="num" title="Span of roll / pitch / yaw, degrees">r/p/y °</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i} className={isCurrent(r.geometry) ? "current" : undefined}>
                  <td className="num">{r.score.toFixed(2)}</td>
                  {varied.map(({ k }) => (
                    <td key={k} className="num">
                      {Number(r.geometry[k].toFixed(1))}
                    </td>
                  ))}
                  <td className="num">
                    {span(r, "x")}/{span(r, "y")}/{span(r, "z")}
                  </td>
                  <td className="num">
                    {span(r, "roll", 1 / DEG)}/{span(r, "pitch", 1 / DEG)}/{span(r, "yaw", 1 / DEG)}
                  </td>
                  <td>
                    {isCurrent(r.geometry) ? (
                      <span className="chip ok">In use</span>
                    ) : (
                      <button type="button" className="ghost" onClick={() => s.applyGeometry(r.geometry)}>
                        Use
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {finished && results.length === 0 && <p className="hint">No layout in these ranges can move on every axis. Widen the ranges or the limits.</p>}
    </div>
  );
}
