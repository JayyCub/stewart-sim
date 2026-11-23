/**
 * The page's two hardware controllers. Both talk to the same Uno and only one program can hold
 * its serial port, so the panels check each other's phase before connecting.
 */
import { useSim } from "../store.ts";
import { JogController } from "./jog.ts";
import { LiveController } from "./live.ts";

/** Follow the sim pose (Hardware panel). */
export const live = new LiveController({
  getTarget: () => useSim.getState().pose,
  getRig: () => useSim.getState().rig,
  setTarget: (pose) => useSim.getState().setFullPose(pose),
});

/** Jog single servos to find the physical limits (Servo limits panel). */
export const jog = new JogController({
  getRig: () => useSim.getState().rig,
  showPose: (pose) => useSim.getState().setFullPose(pose),
});

export type Serial = { requestPort(options?: { filters: { usbVendorId: number }[] }): Promise<import("./link.ts").PortLike> };
export const serial = (navigator as Navigator & { serial?: Serial }).serial;
