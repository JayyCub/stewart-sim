import { useEffect, useSyncExternalStore } from "react";
import { ARDUINO_VENDOR_IDS } from "./hardware/link.ts";
import type { Phase } from "./hardware/live.ts";
import { jog, live, serial } from "./hardware/session.ts";
import { DEG, useSim } from "./store.ts";

const PHASE_LABEL: Record<Phase, string> = {
  disconnected: "Not connected",
  connecting: "Connecting…",
  unknown: "Connected · position unknown",
  live: "Live · following the pose",
  held: "Holding",
  busy: "Working…",
};

const fmt = (v: number) => (Math.abs(v) < 0.05 ? 0 : v).toFixed(1);

/** What the rig follows on this page, for the explanatory text. */
export type FollowSource = "sliders" | "flight";

export function HardwarePanel({ source = "sliders" }: { source?: FollowSource }) {
  const what = source === "flight" ? "the flight" : "the Pose sliders and the roll × pitch map";
  const st = useSyncExternalStore((fn) => live.subscribe(fn), () => live.status);
  const rig = useSim((s) => s.rig);
  const edited = useSim(
    (s) =>
      JSON.stringify(s.geometry) !== JSON.stringify(s.rig.geometry) || JSON.stringify(s.limits) !== JSON.stringify(s.rig.limits),
  );
  const maxHorn = rig.motion?.maxHornDegPerSec;
  const connected = st.phase !== "disconnected" && st.phase !== "connecting";
  const jogPhase = useSyncExternalStore((fn) => jog.subscribe(fn), () => jog.status.phase);

  // Esc stops; hiding the tab stops too (background tabs throttle timers, which would stutter the stream).
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

  const connect = async () => {
    try {
      const port = await serial!.requestPort({ filters: ARDUINO_VENDOR_IDS.map((usbVendorId) => ({ usbVendorId })) });
      await live.connect(port);
    } catch {
      /* chooser cancelled */
    }
  };

  if (!serial) {
    return (
      <p className="hint">
        Live control talks to the Uno over Web Serial, which needs desktop Chrome or Edge on <code>localhost</code> or https.
      </p>
    );
  }

  const c = st.commanded;
  return (
    <div className="hw">
      <div className="hw-state">
        <span className={`hw-dot ${st.phase}`} aria-hidden />
        <span>{PHASE_LABEL[st.phase]}</span>
      </div>

      {st.phase === "disconnected" && (
        <>
          <p className="hint">
            Needs <code>firmware/servo_test</code> (v3) on the Uno. Close the Arduino serial monitor and stop any bench script first: only one program can
            hold the port.
          </p>
          {jogPhase !== "disconnected" && <p className="hw-warn">The Servo limits panel is connected to the Uno. Disconnect it there first.</p>}
          <div className="actions tight">
            <button type="button" className="primary" onClick={() => void connect()} disabled={jogPhase !== "disconnected"}>
              Connect to Uno…
            </button>
          </div>
        </>
      )}

      {st.phase === "unknown" && (
        <>
          <p className="notice warn">
            <strong>Level horns</strong> moves every servo to 0° at once, each at its own full speed (like <code>servo_reset</code>). Keep hands clear.
            The sim pose resets to home, then the rig follows {what}.
          </p>
          <div className="actions tight">
            <button type="button" className="primary" onClick={() => void live.level()} disabled={!maxHorn}>
              Level horns and go live
            </button>
          </div>
        </>
      )}

      {(st.phase === "live" || st.phase === "busy") && c && (
        <button type="button" className="stop" onClick={() => void live.stop()} disabled={st.phase !== "live"}>
          Stop <kbd>Esc</kbd>
        </button>
      )}

      {st.phase === "held" && (
        <div className="actions tight">
          <button type="button" className="primary" onClick={() => live.resume()}>
            Resume following
          </button>
        </div>
      )}

      {(st.phase === "live" || st.phase === "held") && (
        <>
          <div className="slider">
            <label htmlFor="hw-speed">Max horn speed</label>
            <output htmlFor="hw-speed">
              {Math.round(st.speed * (maxHorn ?? 0))}
              <span className="unit">°/s</span>
            </output>
            <input id="hw-speed" type="range" min={0.1} max={1} step={0.05} value={st.speed} onChange={(e) => live.setSpeed(Number(e.target.value))} />
          </div>
          {c && (
            <div className="readout hw-pose" aria-label="Pose sent to the rig">
              <span>sent</span>
              <span>x {fmt(c.pose.x)}</span>
              <span>y {fmt(c.pose.y)}</span>
              <span>z {fmt(c.pose.z)}</span>
              <span>r {fmt(c.pose.roll / DEG)}°</span>
              <span>p {fmt(c.pose.pitch / DEG)}°</span>
              <span>w {fmt(c.pose.yaw / DEG)}°</span>
            </div>
          )}
          <div className="readout hw-stats">
            queue {st.queued}/48 · underruns {st.underruns} · frames {st.framesSent}
          </div>
          {st.targetRejected && <p className="hw-warn">The requested pose fails a limit check, so the rig stays at the last valid pose.</p>}
          {st.blocked && !st.targetRejected && (
            <p className="hw-warn">Path blocked at a limit ({st.blocked}).{source === "sliders" ? " Move the sliders back." : ""}</p>
          )}
        </>
      )}

      {st.message && <p className={st.message.bad ? "hw-error" : "hint"} role={st.message.bad ? "alert" : undefined}>{st.message.text}</p>}

      {connected && (
        <>
          {!maxHorn && <p className="hw-error">rig.json has no motion.maxHornDegPerSec; live control is disabled.</p>}
          {edited && (
            <p className="hint">
              You have edited geometry or limits in the sim. The rig still uses the loaded rig.json ({rig.name}), so the preview may disagree with it.
            </p>
          )}
          {!rig.measured && <p className="hint">rig.json is marked unmeasured: limits are the best current estimates.</p>}
          <div className="actions tight">
            <button type="button" onClick={() => void live.release()} disabled={st.phase === "busy"}>
              Release (limp)
            </button>
            <button type="button" className="ghost" onClick={() => void live.disconnect()} disabled={st.phase === "busy"}>
              Disconnect
            </button>
          </div>
        </>
      )}
    </div>
  );
}
