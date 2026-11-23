/**
 * Standalone flight game: the aircraft in a 3D world beside the Stewart platform it drives.
 * The platform view is the same RigView as the designer, fed by the same store pose that live
 * hardware control follows, so what you see in the inset is what the real rig is told to do.
 */
import { Canvas } from "@react-three/fiber";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { SCENARIOS, TURBULENCE_LEVELS, type TurbulenceLevel } from "@stewart/flight";
import { HardwarePanel } from "../HardwarePanel.tsx";
import { live } from "../hardware/session.ts";
import { RigView } from "../RigView.tsx";
import { flight } from "./controller.ts";
import { FlightClock, Hud } from "./Hud.tsx";
import { MotionPanel } from "./MotionPanel.tsx";
import { useFlight } from "./useFlight.ts";
import { World, type CameraMode } from "./World.tsx";

type Layout = "inset" | "split";
type Drawer = "motion" | "rig" | null;

const PHASE: Record<string, string> = {
  disconnected: "Rig not connected",
  connecting: "Connecting…",
  unknown: "Rig connected · level it to go live",
  live: "Rig live",
  held: "Rig holding",
  busy: "Rig busy…",
};

const typing = (el: EventTarget | null) =>
  el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && el.type !== "range");

function Menu() {
  const scenario = useFlight((s) => s.scenario);
  const turbulence = useFlight((s) => s.turbulence);
  const started = useFlight((s) => s.tel.t > 0);
  const crashed = useFlight((s) => s.tel.crashed);
  const rigReady = useFlight((s) => s.rigReady);
  const rigDropped = useFlight((s) => s.rigDropped);
  const title = crashed ? "Crashed" : started ? "Paused" : "Ready for departure";
  return (
    <div className="fl-menu-wrap">
      <div className="fl-menu" role="dialog" aria-labelledby="fl-menu-title">
        <h2 id="fl-menu-title">{title}</h2>
        {crashed && <p className="fl-menu-note">The aircraft hit the ground. Restart to fly again.</p>}
        {rigDropped && !crashed && <p className="fl-menu-note">The rig stopped following, so the flight paused. Get it live again to carry on.</p>}
        <div className="fl-scenarios" role="radiogroup" aria-label="Scenario">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={s.id === scenario.id}
              className={s.id === scenario.id ? "on" : undefined}
              onClick={() => s.id !== scenario.id && flight.reset(s)}
            >
              <strong>{s.name}</strong>
              <span>{s.description}</span>
            </button>
          ))}
        </div>
        <div className="fl-turb" role="radiogroup" aria-label="Turbulence">
          <span>Turbulence</span>
          {(Object.keys(TURBULENCE_LEVELS) as TurbulenceLevel[]).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={k === turbulence} className={k === turbulence ? "on" : undefined} onClick={() => flight.setTurbulence(k)}>
              {k}
            </button>
          ))}
        </div>
        <div className="fl-keys">
          <span><kbd>↑</kbd><kbd>↓</kbd> pitch</span>
          <span><kbd>←</kbd><kbd>→</kbd> roll</span>
          <span><kbd>A</kbd><kbd>D</kbd> rudder</span>
          <span><kbd>W</kbd><kbd>S</kbd> throttle</span>
          <span><kbd>Space</kbd> pause</span>
          <span><kbd>C</kbd> camera</span>
          <span><kbd>V</kbd> split view</span>
          <span>Gamepad: sticks + triggers</span>
        </div>
        <section className={`fl-rig-step ${rigReady ? "ready" : ""}`} aria-label="Rig">
          <h3>{rigReady ? "✓ Rig live and following" : "Connect the rig to fly"}</h3>
          {!rigReady && (
            <p className="hint">
              The flight only runs while the Stewart platform is live: connect to the Uno, then level the horns. If the rig stops following
              mid-flight (Esc, a lost link), the flight pauses.
            </p>
          )}
          <HardwarePanel source="flight" />
        </section>
        <div className="fl-menu-actions">
          {started && !crashed ? (
            <>
              <button type="button" className="primary" onClick={() => flight.start()} disabled={!rigReady} autoFocus={rigReady}>
                Resume
              </button>
              <button type="button" onClick={() => flight.stop()}>
                Restart
              </button>
            </>
          ) : (
            <button
              type="button"
              className="primary"
              onClick={() => {
                if (crashed) flight.stop();
                flight.start();
              }}
              disabled={!rigReady}
              autoFocus={rigReady}
            >
              {crashed ? "Restart" : "Fly"}
            </button>
          )}
          {!rigReady && <span className="fl-menu-why">Needs the rig live</span>}
        </div>
      </div>
    </div>
  );
}

function DrawerShell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <aside className="fl-drawer" aria-label={title}>
      <header>
        <h2>{title}</h2>
        <button type="button" className="ghost" onClick={onClose} aria-label={`Close ${title}`}>
          Close
        </button>
      </header>
      <div className="fl-drawer-body">{children}</div>
    </aside>
  );
}

export function FlightApp() {
  const [camera, setCamera] = useState<CameraMode>("chase");
  const [layout, setLayout] = useState<Layout>("inset");
  const [drawer, setDrawer] = useState<Drawer>(null);
  const running = useFlight((s) => s.running);
  const rigReady = useFlight((s) => s.rigReady);
  const phase = useSyncExternalStore((fn) => live.subscribe(fn), () => live.status.phase);

  // The rig must always be stoppable, whether or not the Rig drawer (and its own handlers) is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void live.stop();
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") void live.stop();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "c") setCamera((c) => (c === "chase" ? "cockpit" : "chase"));
      else if (k === "v") setLayout((l) => (l === "inset" ? "split" : "inset"));
      else if (k === "m") setDrawer((d) => (d === "motion" ? null : "motion"));
      else if (k === "enter" && !flight.status.running && !(e.target instanceof HTMLButtonElement)) flight.start();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={`fl-app ${layout}`}>
      <section className="fl-world" aria-label="Aircraft view">
        <Canvas camera={{ fov: 62, near: 0.3, far: 40000, position: [0, 1006, 24] }} gl={{ antialias: true, logarithmicDepthBuffer: true }} dpr={[1, 2]}>
          <World mode={camera} />
        </Canvas>
        <Hud />
        {camera === "cockpit" && (
          <svg className="fl-reticle" viewBox="0 0 160 40" aria-hidden="true">
            <path d="M4 20h50l12 12 14-14 14 14 12-12h50" />
          </svg>
        )}
      </section>

      <section className="fl-rig" aria-label="Stewart platform">
        <RigView zoomOut={layout === "inset" ? 1.45 : 1.15} />
        <div className="fl-rig-label">
          <span>Platform</span>
          <span className={`fl-rig-state ${phase}`}>{PHASE[phase] ?? phase}</span>
        </div>
      </section>

      <header className="fl-top">
        <a className="fl-back" href="../">
          ← Rig designer
        </a>
        <FlightClock />
        <div className="fl-tools">
          <button
            type="button"
            onClick={() => (running ? flight.pause() : flight.start())}
            disabled={!running && !rigReady}
            title={!running && !rigReady ? "Connect and level the rig first" : undefined}
          >
            {running ? "Pause" : "Fly"}
          </button>
          <button type="button" aria-pressed={camera === "cockpit"} onClick={() => setCamera((c) => (c === "chase" ? "cockpit" : "chase"))}>
            {camera === "chase" ? "Cockpit view" : "Chase view"}
          </button>
          <button type="button" aria-pressed={layout === "split"} onClick={() => setLayout((l) => (l === "inset" ? "split" : "inset"))}>
            {layout === "inset" ? "Split view" : "Inset view"}
          </button>
          <button type="button" aria-pressed={drawer === "motion"} onClick={() => setDrawer((d) => (d === "motion" ? null : "motion"))}>
            Motion
          </button>
          <button type="button" aria-pressed={drawer === "rig"} className={phase === "live" ? "live" : undefined} onClick={() => setDrawer((d) => (d === "rig" ? null : "rig"))}>
            Rig
          </button>
        </div>
      </header>

      {!running && <Menu />}

      {drawer === "motion" && (
        <DrawerShell title="Motion cueing" onClose={() => setDrawer(null)}>
          <MotionPanel />
        </DrawerShell>
      )}
      {drawer === "rig" && (
        <DrawerShell title="Rig connection" onClose={() => setDrawer(null)}>
          <HardwarePanel source="flight" />
        </DrawerShell>
      )}
    </div>
  );
}
