import { useEffect, useRef, useState } from "react";
import { HISTORY_S, type Sample } from "./controller.ts";

interface Props {
  title: string;
  unit: string;
  /** Index into Sample.ac / Sample.pl. */
  channel: number;
  history: Sample[];
  /** Smallest half-range of the y axis, so a quiet signal isn't blown up to full height. */
  minSpan: number;
}

const SERIES = [
  { key: "ac" as const, name: "Aircraft", cls: "s1", varName: "--series-1" },
  { key: "pl" as const, name: "Platform", cls: "s2", varName: "--series-2" },
];

const fmt = (v: number) => (Math.abs(v) < 0.005 ? 0 : v).toFixed(2);

/**
 * Strip chart of one cue channel over the last HISTORY_S seconds: what the pilot feels in the
 * aircraft vs what the rider gets from the platform. Symmetric y axis around zero, one scale.
 */
export function CueChart({ title, unit, channel, history, minSpan }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; s: Sample } | null>(null);
  const last = history.at(-1);

  const tEnd = last?.t ?? HISTORY_S;
  const tStart = tEnd - HISTORY_S;
  const span = Math.max(minSpan, ...history.map((h) => Math.max(Math.abs(h.ac[channel]!), Math.abs(h.pl[channel]!)))) * 1.1;

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(c);
    const X = (t: number) => ((t - tStart) / HISTORY_S) * w;
    const Y = (v: number) => h / 2 - (v / span) * (h / 2 - 4);

    // Zero line and 5 s grid, recessive.
    ctx.strokeStyle = css.getPropertyValue("--line");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(h / 2) + 0.5);
    ctx.lineTo(w, Math.round(h / 2) + 0.5);
    for (let t = Math.ceil(tStart / 5) * 5; t <= tEnd; t += 5) {
      const x = Math.round(X(t)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    ctx.stroke();

    for (const s of SERIES) {
      ctx.strokeStyle = css.getPropertyValue(s.varName);
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.beginPath();
      history.forEach((p, i) => {
        const x = X(p.t), y = Y(p[s.key][channel]!);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    if (hover) {
      ctx.strokeStyle = css.getPropertyValue("--muted");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(hover.x) + 0.5, 0);
      ctx.lineTo(Math.round(hover.x) + 0.5, h);
      ctx.stroke();
      for (const s of SERIES) {
        ctx.fillStyle = css.getPropertyValue(s.varName);
        ctx.strokeStyle = css.getPropertyValue("--panel");
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(X(hover.s.t), Y(hover.s[s.key][channel]!), 4, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
      }
    }
  });

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!history.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const t = tStart + ((e.clientX - r.left) / r.width) * HISTORY_S;
    let best = history[0]!;
    for (const h of history) if (Math.abs(h.t - t) < Math.abs(best.t - t)) best = h;
    setHover({ x: ((best.t - tStart) / HISTORY_S) * r.width, s: best });
  };

  const shown = hover?.s ?? last;
  return (
    <figure className="cue-chart">
      <figcaption>
        <span className="cue-title">
          {title} <span className="unit">{unit}</span>
        </span>
        <span className="cue-legend">
          {SERIES.map((s) => (
            <span key={s.key}>
              <i className={`cue-swatch ${s.cls}`} aria-hidden="true" />
              {s.name} <b>{shown ? fmt(shown[s.key][channel]!) : "–"}</b>
            </span>
          ))}
        </span>
      </figcaption>
      <div className="cue-plot">
        <span className="cue-tick top">{span.toFixed(1)}</span>
        <span className="cue-tick bottom">−{span.toFixed(1)}</span>
        <canvas
          ref={canvas}
          role="img"
          aria-label={`${title}: aircraft ${shown ? fmt(shown.ac[channel]!) : "–"}, platform ${shown ? fmt(shown.pl[channel]!) : "–"} ${unit}`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
        {hover && <span className="cue-time" style={{ left: hover.x }}>{`${(hover.s.t - tEnd).toFixed(1)} s`}</span>}
      </div>
    </figure>
  );
}
