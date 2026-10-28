import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { DEG, TILT_BALL, TILT_COLLISION, TILT_NO_SOLUTION, TILT_OK, TILT_SERVO, tiltAt, tiltMap } from "@stewart/kinematics";
import { useSim } from "./store.ts";

/** Half-width of the map in degrees; matches the roll and pitch sliders. */
const RANGE_DEG = 35;
const N = 71;
const TICKS = [-30, -15, 0, 15, 30];

const LEGEND = [
  { cell: TILT_OK, label: "Reachable", token: "--reach" },
  { cell: TILT_BALL, label: "Ball joint", token: "--warn" },
  { cell: TILT_COLLISION, label: "Collision", token: "--clash" },
  { cell: TILT_SERVO, label: "Servo limit", token: "--bad" },
  { cell: TILT_NO_SOLUTION, label: "Out of reach", token: "--track" },
] as const;

/** Re-render when the colour scheme flips, so the canvas picks up the new tokens. */
function useColorScheme() {
  const [, bump] = useState(0);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => bump((k) => k + 1);
    mq.addEventListener("change", onChange);
    const mo = new MutationObserver(onChange);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq.removeEventListener("change", onChange);
      mo.disconnect();
    };
  }, []);
}

export function TiltMapView() {
  const s = useSim();
  const canvas = useRef<HTMLCanvasElement>(null);
  useColorScheme();
  const { x, y, z, yaw } = s.pose;

  const map = useMemo(
    () => tiltMap(s.layout, s.geometry, s.limits, { x, y, z, yaw, roll: 0, pitch: 0 }, RANGE_DEG * DEG, N, s.rig.collision),
    [s.layout, s.geometry, s.limits, s.rig.collision, x, y, z, yaw],
  );
  const reachable = map.cells.reduce((k, c) => k + (c === TILT_OK ? 1 : 0), 0) / map.cells.length;

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    const css = getComputedStyle(document.documentElement);
    const colour = Object.fromEntries(LEGEND.map((l) => [l.cell, css.getPropertyValue(l.token).trim()]));
    // One pixel per cell; CSS scales it up with crisp edges. Row 0 is the most negative pitch, drawn at the bottom.
    ctx.clearRect(0, 0, N, N);
    for (let row = 0; row < N; row++) {
      for (let col = 0; col < N; col++) {
        ctx.fillStyle = colour[map.cells[row * N + col]!]!;
        ctx.fillRect(col, N - 1 - row, 1, 1);
      }
    }
  });

  /** Map a pointer position to the nearest cell's roll and pitch. */
  const pick = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const col = Math.round(((e.clientX - r.left) / r.width) * N - 0.5);
    const row = N - 1 - Math.round(((e.clientY - r.top) / r.height) * N - 0.5);
    if (col < 0 || col >= N || row < 0 || row >= N) return;
    const t = tiltAt(map, row, col);
    s.setPose("roll", Math.round((t.roll / DEG) * 2) / 2 * DEG);
    s.setPose("pitch", Math.round((t.pitch / DEG) * 2) / 2 * DEG);
  };

  const pct = (deg: number) => `${((deg + RANGE_DEG) / (2 * RANGE_DEG)) * 100}%`;
  const rollDeg = s.pose.roll / DEG, pitchDeg = s.pose.pitch / DEG;
  const markerOn = Math.abs(rollDeg) <= RANGE_DEG && Math.abs(pitchDeg) <= RANGE_DEG;

  return (
    <div className="tiltmap">
      <div className="tiltmap-plot">
        <span className="tiltmap-ylabel">Pitch °</span>
        <div className="tiltmap-yticks" aria-hidden>
          {TICKS.map((t) => (
            <span key={t} style={{ bottom: pct(t) }}>{t}</span>
          ))}
        </div>
        <div className="tiltmap-frame">
          <canvas
            ref={canvas}
            width={N}
            height={N}
            role="img"
            aria-label={`Roll by pitch reachability, ${Math.round(reachable * 100)}% of the grid reachable. Click to set roll and pitch.`}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              pick(e);
            }}
            onPointerMove={(e) => e.buttons & 1 && pick(e)}
          />
          <span className="tiltmap-axis v" style={{ left: pct(0) }} aria-hidden />
          <span className="tiltmap-axis h" style={{ bottom: pct(0) }} aria-hidden />
          {markerOn && (
            <span className={`tiltmap-marker${s.solution.ok ? "" : " bad"}`} style={{ left: pct(rollDeg), bottom: pct(pitchDeg) }} aria-hidden />
          )}
        </div>
        <div className="tiltmap-xticks" aria-hidden>
          {TICKS.map((t) => (
            <span key={t} style={{ left: pct(t) }}>{t}</span>
          ))}
        </div>
        <span className="tiltmap-xlabel">Roll °</span>
      </div>
      <ul className="tiltmap-legend">
        {LEGEND.map((l) => (
          <li key={l.cell}>
            <span className="swatch" style={{ background: `var(${l.token})` }} />
            {l.label}
          </li>
        ))}
      </ul>
      <p className="hint">
        {Math.round(reachable * 100)}% of ±{RANGE_DEG}° reachable at the current x, y, z and yaw. Click or drag to set roll and pitch.
      </p>
    </div>
  );
}
