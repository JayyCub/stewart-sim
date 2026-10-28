import { create } from "zustand";
import { DEG, buildLayout, solve, workspace, type Axis, type Collision, type Geometry, type Layout, type Limits, type Pose, type Reach, type Solution } from "@stewart/kinematics";
import { defaultRig, type RigConfig } from "@stewart/rig-config";

export const HOME: Pose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };

interface Derived {
  layout: Layout;
  solution: Solution;
  reach: Record<Axis, Reach>;
}

interface State extends Derived {
  rig: RigConfig;
  geometry: Geometry;
  limits: Limits;
  pose: Pose;
  setGeometry: (k: keyof Geometry, v: number) => void;
  /** Replace the whole geometry at once (e.g. from a sweep result) and return to home. */
  applyGeometry: (g: Geometry) => void;
  setLimit: (k: keyof Limits, v: number) => void;
  setPose: (k: Axis, v: number) => void;
  resetPose: () => void;
  /** Replace the rig with a validated config and return to home. */
  loadRig: (rig: RigConfig) => void;
  /** Discard slider edits and go back to the loaded rig. */
  resetRig: () => void;
}

function derive(geometry: Geometry, limits: Limits, pose: Pose, col: Collision): Derived {
  const layout = buildLayout(geometry);
  return { layout, solution: solve(layout, geometry, limits, pose, col), reach: workspace(layout, geometry, limits, col) };
}

export const useSim = create<State>((set, get) => ({
  rig: defaultRig,
  geometry: { ...defaultRig.geometry },
  limits: { ...defaultRig.limits },
  pose: HOME,
  ...derive(defaultRig.geometry, defaultRig.limits, HOME, defaultRig.collision),

  setGeometry: (k, v) => {
    const geometry = { ...get().geometry, [k]: v };
    set({ geometry, ...derive(geometry, get().limits, get().pose, get().rig.collision) });
  },
  applyGeometry: (g) => {
    const geometry = { ...g };
    set({ geometry, pose: HOME, ...derive(geometry, get().limits, HOME, get().rig.collision) });
  },
  setLimit: (k, v) => {
    const limits = { ...get().limits, [k]: v };
    set({ limits, ...derive(get().geometry, limits, get().pose, get().rig.collision) });
  },
  setPose: (k, v) => {
    const pose = { ...get().pose, [k]: v };
    const { layout, geometry, limits, rig } = get();
    set({ pose, solution: solve(layout, geometry, limits, pose, rig.collision) });
  },
  resetPose: () => {
    const { layout, geometry, limits, rig } = get();
    set({ pose: HOME, solution: solve(layout, geometry, limits, HOME, rig.collision) });
  },
  loadRig: (rig) => {
    set({ rig, geometry: { ...rig.geometry }, limits: { ...rig.limits }, pose: HOME, ...derive(rig.geometry, rig.limits, HOME, rig.collision) });
  },
  resetRig: () => get().loadRig(get().rig),
}));

/** Current geometry and limits as a rig.json document, keeping the servo calibration from the loaded config. */
export function exportRigJson(s: Pick<State, "rig" | "geometry" | "limits">): string {
  const round = <T extends object>(o: T) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round((v as number) * 100) / 100])) as T;
  const out: RigConfig = { ...s.rig, geometry: round(s.geometry), limits: round(s.limits) };
  return JSON.stringify(out, null, 2) + "\n";
}

export { DEG };
