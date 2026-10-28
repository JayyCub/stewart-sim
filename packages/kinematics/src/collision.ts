import { DEG, dot, norm, sub } from "./math.ts";
import type { Collision, LegFault, LegSolution, Layout, Vec3 } from "./types.ts";

/**
 * Collision model.
 *
 * Each servo is a box standing upright with its shaft horizontal and radial.
 * In the servo's local frame (r along the shaft axis from the horn pivot,
 * positive outward; s tangential; z up from shaft height) the body spans
 *   r in [-(inset + depth), -inset], s in [-width/2, width/2],
 *   z in [shaftFromTop - length, shaftFromTop].
 * Rods are capsules of radius rodRadius between the two ball centres.
 */

/** Defaults: MG996R listing dimensions, the 3D view's 3 mm horn spacing, an M3 rod. */
export const DEFAULT_COLLISION: Collision = {
  servoLength: 40.7,
  servoWidth: 19.7,
  servoDepth: 42.9,
  shaftFromTop: 10,
  servoInset: 3,
  rodRadius: 2,
  minClearance: 0,
  hornRodMinDeg: 20,
};

interface Frame {
  B: Vec3;
  u: Vec3;
  t: Vec3;
}

const frameOf = (layout: Layout, i: number): Frame => {
  const B = layout.base[i]!, u = layout.shaftAxis[i]!;
  return { B, u, t: [-u[1], u[0], 0] };
};

/** Point in servo i's local (r, s, z) frame. */
const toLocal = (f: Frame, p: Vec3): Vec3 => {
  const d = sub(p, f.B);
  return [dot(d, f.u), dot(d, f.t), d[2]];
};

/** Servo body footprint corners in the base xy plane. */
function footprint(f: Frame, c: Collision): [number, number][] {
  const out: [number, number][] = [];
  for (const r of [-c.servoInset, -(c.servoInset + c.servoDepth)])
    for (const s of [-c.servoWidth / 2, c.servoWidth / 2])
      out.push([f.B[0] + f.u[0] * r + f.t[0] * s, f.B[1] + f.u[1] * r + f.t[1] * s]);
  return out;
}

/**
 * Pairs of servos whose bodies overlap or come closer than minClearance.
 * Separating-axis test on the footprints; bodies share the same z span.
 */
export function servoClashes(layout: Layout, c: Collision): [number, number][] {
  const frames = layout.base.map((_, i) => frameOf(layout, i));
  const prints = frames.map((f) => footprint(f, c));
  const clashes: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    for (let j = i + 1; j < 6; j++) {
      const axes = [frames[i]!.u, frames[i]!.t, frames[j]!.u, frames[j]!.t];
      const separated = axes.some((ax) => {
        const proj = (pts: [number, number][]) => pts.map((p) => p[0] * ax[0] + p[1] * ax[1]);
        const a = proj(prints[i]!), b = proj(prints[j]!);
        const gap = Math.max(Math.min(...b) - Math.max(...a), Math.min(...a) - Math.max(...b));
        return gap >= c.minClearance;
      });
      if (!separated) clashes.push([i, j]);
    }
  }
  return clashes;
}

/** Slab test: does segment p0 -> p1 pass through the axis-aligned box [lo, hi]? */
function segmentHitsBox(p0: Vec3, p1: Vec3, lo: Vec3, hi: Vec3): boolean {
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 3; k++) {
    const d = p1[k]! - p0[k]!;
    if (Math.abs(d) < 1e-12) {
      if (p0[k]! < lo[k]! || p0[k]! > hi[k]!) return false;
      continue;
    }
    let a = (lo[k]! - p0[k]!) / d, b = (hi[k]! - p0[k]!) / d;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Collision faults for one solved pose. `clashing` is the set of legs whose
 * servo bodies clash (from servoClashes), which fails every pose.
 */
export function collisionFaults(layout: Layout, c: Collision, legs: LegSolution[], clashing: ReadonlySet<number>): LegFault[][] {
  const frames = layout.base.map((_, i) => frameOf(layout, i));
  // Body box inflated by the rod radius, so a capsule test becomes a segment test.
  const r = c.rodRadius;
  const lo: Vec3 = [-(c.servoInset + c.servoDepth) - r, -c.servoWidth / 2 - r, c.shaftFromTop - c.servoLength - r];
  const hi: Vec3 = [-c.servoInset + r, c.servoWidth / 2 + r, c.shaftFromTop + r];
  const minFold = Math.cos(c.hornRodMinDeg * DEG);

  return legs.map((leg, i) => {
    const faults: LegFault[] = [];
    if (clashing.has(i)) faults.push("servo-clash");
    if (Number.isNaN(leg.alpha)) return faults;

    if (frames.some((f) => segmentHitsBox(toLocal(f, leg.hornTip), toLocal(f, leg.top), lo, hi))) faults.push("rod-hits-servo");

    // Angle at the bottom ball between the horn (back toward the shaft) and the rod.
    const toPivot = sub(leg.pivot, leg.hornTip), toTop = sub(leg.top, leg.hornTip);
    if (dot(toPivot, toTop) / (norm(toPivot) * norm(toTop)) > minFold) faults.push("rod-hits-horn");
    return faults;
  });
}
