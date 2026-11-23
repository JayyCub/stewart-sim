/**
 * Compact live-hardware control for the flight page: status dot, label and the one next step
 * (Connect → Level → live). The full Hardware panel lives in the rig designer.
 */
import { useSyncExternalStore } from "react";
import { ARDUINO_VENDOR_IDS } from "../hardware/link.ts";
import { live, serial } from "../hardware/session.ts";
import { useSim } from "../store.ts";

const LABEL: Record<string, string> = {
  disconnected: "Offline",
  connecting: "Connecting…",
  unknown: "Connected",
  live: "Live",
  held: "Held",
  busy: "Working…",
};

export const rigLabel = (phase: string) => LABEL[phase] ?? phase;

export function RigControl({ full = false }: { full?: boolean }) {
  const st = useSyncExternalStore((fn) => live.subscribe(fn), () => live.status);
  const maxHorn = useSim((s) => s.rig.motion?.maxHornDegPerSec);
  const connected = st.phase !== "disconnected" && st.phase !== "connecting";

  const connect = async () => {
    try {
      const port = await serial!.requestPort({ filters: ARDUINO_VENDOR_IDS.map((usbVendorId) => ({ usbVendorId })) });
      await live.connect(port);
    } catch {
      /* chooser cancelled */
    }
  };

  if (!serial) return <p className="rc-line rc-bad">Live control needs desktop Chrome or Edge.</p>;

  return (
    <div className="rc">
      <div className="rc-line">
        <span className={`hw-dot ${st.phase}`} aria-hidden />
        <span className="rc-state">{rigLabel(st.phase)}</span>
        <span className="rc-action">
          {st.phase === "disconnected" && (
            <button type="button" className="primary" onClick={() => void connect()}>
              Connect
            </button>
          )}
          {st.phase === "unknown" && (
            <button type="button" className="primary" onClick={() => void live.level()} disabled={!maxHorn} title="All servos move to level at once">
              Level horns
            </button>
          )}
          {st.phase === "held" && (
            <button type="button" className="primary" onClick={() => live.resume()}>
              Resume
            </button>
          )}
          {st.phase === "live" && (
            <button type="button" className="stop" onClick={() => void live.stop()}>
              Stop <kbd>Esc</kbd>
            </button>
          )}
        </span>
      </div>
      {st.phase === "unknown" && <p className="rc-note">Servos snap to level. Hands clear.</p>}
      {st.message?.bad && (
        <p className="rc-line rc-bad" role="alert">
          {st.message.text}
        </p>
      )}
      {!maxHorn && connected && <p className="rc-line rc-bad">rig.json has no motion.maxHornDegPerSec</p>}

      {full && (st.phase === "live" || st.phase === "held") && (
        <div className="slider">
          <label htmlFor="rc-speed">Max horn speed</label>
          <output htmlFor="rc-speed">
            {Math.round(st.speed * (maxHorn ?? 0))}
            <span className="unit">°/s</span>
          </output>
          <input id="rc-speed" type="range" min={0.1} max={1} step={0.05} value={st.speed} onChange={(e) => live.setSpeed(Number(e.target.value))} />
        </div>
      )}
      {full && (st.phase === "live" || st.phase === "held") && (
        <dl className="rc-stats">
          <dt>Queue</dt>
          <dd>{st.queued}/48</dd>
          <dt>Underruns</dt>
          <dd>{st.underruns}</dd>
          <dt>Frames</dt>
          <dd>{st.framesSent}</dd>
        </dl>
      )}
      {full && st.blocked && <p className="rc-line rc-bad">At a limit: {st.blocked}</p>}
      {full && connected && (
        <div className="rc-line">
          <button type="button" onClick={() => void live.release()} disabled={st.phase === "busy"}>
            Release
          </button>
          <button type="button" className="ghost" onClick={() => void live.disconnect()} disabled={st.phase === "busy"}>
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
