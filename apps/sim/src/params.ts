import type { Geometry } from "@stewart/kinematics";

/** Geometry parameters: labels and slider bounds, shared by the sliders and the sweep. */
export const GEO: { k: keyof Geometry; label: string; unit: string; min: number; max: number; step: number }[] = [
  { k: "baseRadius", label: "Base radius", unit: "mm", min: 40, max: 160, step: 0.5 },
  { k: "platformRadius", label: "Platform radius", unit: "mm", min: 30, max: 140, step: 0.5 },
  { k: "baseHalfAngleDeg", label: "Servo pair half-spacing", unit: "°", min: 3, max: 40, step: 0.5 },
  { k: "platformHalfAngleDeg", label: "Top joint half-spacing", unit: "°", min: 3, max: 58, step: 0.5 },
  { k: "hornLength", label: "Horn length", unit: "mm", min: 10, max: 40, step: 0.5 },
  { k: "rodLength", label: "Rod length", unit: "mm", min: 60, max: 220, step: 0.5 },
];
