import { DEG, add, dot, norm, scale, sub } from "./math.ts";
import type { Collision, LegFault, LegSolution, Layout, Vec3 } from "./types.ts";

/**
 * Collision model.
 *
 * Each servo is a box fixed to its shaft. In the servo's local frame (r along
 * the shaft from the horn pivot, positive outward; s along the horn's level
 * direction; z along the horn's up direction, which is vertical for an
 * untilted servo) the body spans
 *   r in [-(inset + depth), -inset], s in [shaftFromSide - width, shaftFromSide],
 *   z in [shaftFromTop - length, shaftFromTop].
 * Since s points away from the pair partner, a shaftFromSide under width/2 puts most
 * of the body on the partner's side.
 * Rods are capsules of radius rodRadius between the two ball centres.
 */

/** Defaults: MG996R listing dimensions, the 3D view's 3 mm horn spacing, an M3 rod. */
export const DEFAULT_COLLISION: Collision = {
  servoLength: 40.7,
  servoWidth: 19.7,
  servoDepth: 42.9,
  shaftFromTop: 10,
  shaftFromSide: 9.85, // servoWidth / 2: body centred across the horn direction
  servoInset: 3,
  rodRadius: 2,
  minClearance: 0,
  hornRodMinDeg: 20,
};

/** Servo i's local frame: origin at the horn pivot, axes r (shaft), s (horn level), z (horn up). */
export interface ServoFrame {
  B: Vec3;
  r: Vec3;
  s: Vec3;
  z: Vec3;
}

export const servoFrame = (layout: Layout, i: number): ServoFrame => ({
  B: layout.base[i]!,
  r: layout.shaftAxis[i]!,
  s: layout.hornDir[i]!,
  z: layout.hornUp[i]!,
});

/** Point in a servo's local (r, s, z) frame. */
const toLocal = (f: ServoFrame, p: Vec3): Vec3 => {
  const d = sub(p, f.B);
  return [dot(d, f.r), dot(d, f.s), dot(d, f.z)];
};

/** Local bounds of the servo body: [lo, hi] in (r, s, z). */
const bodyBox = (c: Collision): [Vec3, Vec3] => [
  [-(c.servoInset + c.servoDepth), c.shaftFromSide - c.servoWidth, c.shaftFromTop - c.servoLength],
  [-c.servoInset, c.shaftFromSide, c.shaftFromTop],
];

/** The eight corners of servo i's body in the base frame. */
export function servoCorners(f: ServoFrame, c: Collision): Vec3[] {
  const [lo, hi] = bodyBox(c);
  const out: Vec3[] = [];
  for (const r of [lo[0], hi[0]])
    for (const s of [lo[1], hi[1]])
      for (const z of [lo[2], hi[2]]) out.push(add(f.B, add(scale(f.r, r), add(scale(f.s, s), scale(f.z, z)))));
  return out;
}

const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Pairs of servos whose bodies overlap or come closer than minClearance.
 * Separating-axis test on the two boxes: their 3 + 3 face normals and the
 * 9 edge-pair cross products, so tilted and turned servos are handled.
 */
export function servoClashes(layout: Layout, c: Collision): [number, number][] {
  const frames = layout.base.map((_, i) => servoFrame(layout, i));
  const corners = frames.map((f) => servoCorners(f, c));
  const clashes: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    for (let j = i + 1; j < 6; j++) {
      const fi = frames[i]!, fj = frames[j]!;
      const ai = [fi.r, fi.s, fi.z], aj = [fj.r, fj.s, fj.z];
      const axes: Vec3[] = [...ai, ...aj];
      for (const a of ai) for (const b of aj) {
        const x = cross3(a, b);
        if (norm(x) > 1e-9) axes.push(scale(x, 1 / norm(x)));
      }
      const separated = axes.some((ax) => {
        const pa = corners[i]!.map((p) => dot(p, ax)), pb = corners[j]!.map((p) => dot(p, ax));
        const gap = Math.max(Math.min(...pb) - Math.max(...pa), Math.min(...pa) - Math.max(...pb));
        return gap >= c.minClearance;
      });
      if (!separated) clashes.push([i, j]);
    }
  }
  return clashes;
}

/** Angle at the bottom ball between the horn (back toward the shaft) and the rod, radians. NaN if unsolved. */
export function hornRodAngle(leg: LegSolution): number {
  if (Number.isNaN(leg.alpha)) return NaN;
  const toPivot = sub(leg.pivot, leg.hornTip), toTop = sub(leg.top, leg.hornTip);
  return Math.acos(Math.max(-1, Math.min(1, dot(toPivot, toTop) / (norm(toPivot) * norm(toTop)))));
}

/** Largest per-axis distance from point p to box [lo, hi] (0 inside): the box inflated by d on each axis just touches p. */
const boxDistInf = (p: Vec3, lo: Vec3, hi: Vec3): number =>
  Math.max(0, lo[0] - p[0], p[0] - hi[0], lo[1] - p[1], p[1] - hi[1], lo[2] - p[2], p[2] - hi[2]);

/**
 * How far the rod's centre line passes from the nearest servo body, mm, measured the way the
 * rod-hits-servo check measures it (each body box grown by the same amount on every axis). The
 * check fires exactly when this is ≤ rodRadius, so at a pose where the real rod touches a servo,
 * this value is the rodRadius that makes the model agree. NaN if the leg is unsolved.
 */
export function rodBodyGap(layout: Layout, c: Collision, leg: LegSolution): number {
  if (Number.isNaN(leg.alpha)) return NaN;
  const [lo, hi] = bodyBox(c);
  let best = Infinity;
  for (let i = 0; i < layout.base.length; i++) {
    const f = servoFrame(layout, i);
    const a = toLocal(f, leg.hornTip), b = toLocal(f, leg.top);
    const at = (t: number) => boxDistInf([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], lo, hi);
    // Distance to a convex box is convex along the segment: ternary search finds the minimum.
    let t0 = 0, t1 = 1;
    for (let k = 0; k < 80; k++) {
      const m1 = t0 + (t1 - t0) / 3, m2 = t1 - (t1 - t0) / 3;
      if (at(m1) <= at(m2)) t1 = m2;
      else t0 = m1;
    }
    best = Math.min(best, at((t0 + t1) / 2), at(0), at(1));
  }
  return best;
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
  const frames = layout.base.map((_, i) => servoFrame(layout, i));
  // Body box inflated by the rod radius, so a capsule test becomes a segment test.
  const r = c.rodRadius;
  const [blo, bhi] = bodyBox(c);
  const lo: Vec3 = [blo[0] - r, blo[1] - r, blo[2] - r];
  const hi: Vec3 = [bhi[0] + r, bhi[1] + r, bhi[2] + r];
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
