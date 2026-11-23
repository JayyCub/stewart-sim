import { useEffect, useRef } from "react";
import { G0 } from "@stewart/flight";
import { useFlight } from "./useFlight.ts";

const DEG = 180 / Math.PI;
const KT = 1.943844;
const FT = 3.28084;

/** Attitude indicator: sky and ground roll and pitch behind a fixed aircraft symbol, with a bank scale. */
export function Attitude({ bank, pitch, size = 120 }: { bank: number; pitch: number; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const s = size;
    c.width = c.height = Math.round(s * dpr);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, s, s);
    ctx.save();
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s / 2 - 1, 0, 2 * Math.PI);
    ctx.clip();
    ctx.translate(s / 2, s / 2);
    ctx.rotate(-bank);
    const pxPerDeg = s / 60; // ±30° of pitch to the rim
    const off = pitch * DEG * pxPerDeg;
    ctx.fillStyle = "#4f86c0";
    ctx.fillRect(-s, -2 * s + off, 2 * s, 2 * s);
    ctx.fillStyle = "#7d5f3c";
    ctx.fillRect(-s, off, 2 * s, 2 * s);
    ctx.strokeStyle = "#ffffff";
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-s, off);
    ctx.lineTo(s, off);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.font = "9px 'IBM Plex Mono', monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const p of [-20, -10, 10, 20]) {
      const y = off - p * pxPerDeg;
      const w = s * (Math.abs(p) === 10 ? 0.12 : 0.2);
      ctx.beginPath();
      ctx.moveTo(-w, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillText(String(Math.abs(p)), w + 3, y);
    }
    ctx.restore();
    // Bank scale (fixed) and pointer (rolls with the horizon).
    ctx.save();
    ctx.translate(s / 2, s / 2);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    for (const b of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const a = (b / DEG) - Math.PI / 2;
      const r0 = s / 2 - 2, r1 = r0 - (b % 30 === 0 ? 9 : 5);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.stroke();
    }
    ctx.rotate(-bank);
    ctx.fillStyle = "#ffd25e";
    ctx.beginPath();
    ctx.moveTo(0, -s / 2 + 11);
    ctx.lineTo(-5, -s / 2 + 19);
    ctx.lineTo(5, -s / 2 + 19);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // Aircraft symbol.
    ctx.strokeStyle = "#ffd25e";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(s * 0.2, s / 2);
    ctx.lineTo(s * 0.4, s / 2);
    ctx.lineTo(s / 2, s * 0.57);
    ctx.lineTo(s * 0.6, s / 2);
    ctx.lineTo(s * 0.8, s / 2);
    ctx.stroke();
  }, [bank, pitch, size]);
  return (
    <canvas
      ref={ref}
      className="fl-attitude"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Bank ${(bank * DEG).toFixed(0)}°, pitch ${(pitch * DEG).toFixed(0)}°`}
    />
  );
}

/** Rounded, without a "-0". */
const r = (v: number, d = 0) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);
const heading = (psi: number) => ((Math.round(psi * DEG) % 360) + 360) % 360;
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export function Hud() {
  const tel = useFlight((s) => s.tel);
  const scale = useFlight((s) => s.scale);
  const hdg = heading(tel.euler[2]);
  const agl = tel.alt - tel.ground;
  const nz = -tel.fPilot[2] / G0;
  const thr = tel.controls.throttle;
  return (
    <>
      <div className="fl-tape left" aria-label="Airspeed">
        <span className="fl-tape-label">Speed</span>
        <span className="fl-tape-value">{(tel.air.Va * KT).toFixed(0)}</span>
        <span className="fl-tape-unit">kt</span>
      </div>
      <div className="fl-tape right" aria-label="Altitude">
        <span className="fl-tape-label">Altitude</span>
        <span className="fl-tape-value">{(tel.alt * FT).toFixed(0)}</span>
        <span className="fl-tape-unit">ft</span>
        <span className="fl-tape-sub">
          {tel.climb >= 0 ? "▲" : "▼"} {Math.abs(tel.climb * FT * 60).toFixed(0)} fpm
        </span>
        <span className={`fl-tape-sub ${agl < 150 ? "warn" : ""}`}>AGL {(agl * FT).toFixed(0)}</span>
      </div>
      <div className="fl-heading" aria-label="Heading">
        {String(hdg).padStart(3, "0")}° <span>{COMPASS[Math.round(hdg / 45) % 8]}</span>
      </div>
      <div className="fl-panel">
        <Attitude bank={tel.euler[0]} pitch={tel.euler[1]} />
        <dl className="fl-readouts">
          <dt>Bank</dt>
          <dd>{r(tel.euler[0] * DEG)}°</dd>
          <dt>Pitch</dt>
          <dd>{r(tel.euler[1] * DEG, 1)}°</dd>
          <dt>G</dt>
          <dd>{nz.toFixed(2)}</dd>
          <dt>Throttle</dt>
          <dd>
            <span className="fl-bar" aria-hidden="true">
              <i style={{ width: `${thr * 100}%` }} />
            </span>
            {(thr * 100).toFixed(0)}%
          </dd>
          <dt>Cue</dt>
          <dd className={scale < 0.999 ? "warn" : undefined}>{scale < 0.999 ? `${(scale * 100).toFixed(0)}%` : "Full"}</dd>
        </dl>
      </div>
    </>
  );
}

/** Small "t = …" and scenario label for the top bar. */
export function FlightClock() {
  const t = useFlight((s) => Math.floor(s.tel.t * 10) / 10);
  const name = useFlight((s) => s.scenario.name);
  return (
    <span className="fl-clock">
      {name} · {t.toFixed(1)} s
    </span>
  );
}

