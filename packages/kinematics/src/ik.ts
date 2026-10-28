import { DEG, add, dot, mul, norm, rotation, scale, sub, unit } from "./math.ts";
import type { Geometry, LegFault, LegSolution, Layout, Limits, Pose, Solution, Vec3 } from "./types.ts";

/** Centres of the three servo pairs, radians. Pair k holds legs 2k and 2k+1. */
const PAIR_CENTRES = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];

/**
 * Build the fixed joint layout for a geometry.
 *
 * Servos come in three pairs. In each pair the horns point away from each
 * other: leg 2k sits at (centre - baseHalfAngle) with its horn swinging
 * toward decreasing angle, and leg 2k+1 mirrors it. Top joints are paired
 * around the same centres using platformHalfAngle.
 *
 * homeHeight is NaN when the rod is too short to reach the platform with
 * level horns, which means the geometry cannot be built.
 */
export function buildLayout(g: Geometry): Layout {
  const base: Vec3[] = [];
  const platform: Vec3[] = [];
  const beta: number[] = [];
  const shaftAxis: Vec3[] = [];
  const topStudAxis: Vec3[] = [];

  for (const c of PAIR_CENTRES) {
    for (const side of [-1, 1] as const) {
      const tb = c + side * g.baseHalfAngleDeg * DEG;
      const tp = c + side * g.platformHalfAngleDeg * DEG;
      base.push([g.baseRadius * Math.cos(tb), g.baseRadius * Math.sin(tb), 0]);
      platform.push([g.platformRadius * Math.cos(tp), g.platformRadius * Math.sin(tp), 0]);
      beta.push(tb + (side * Math.PI) / 2);
      shaftAxis.push([Math.cos(tb), Math.sin(tb), 0]);
      topStudAxis.push([Math.cos(tp), Math.sin(tp), 0]);
    }
  }

  // Home: horns level (alpha = 0). Solve the platform height from leg 0;
  // the layout has three-fold symmetry and mirror symmetry inside each pair,
  // so every leg gives the same answer.
  const b0 = base[0]!, p0 = platform[0]!, beta0 = beta[0]!;
  const tip: Vec3 = [b0[0] + g.hornLength * Math.cos(beta0), b0[1] + g.hornLength * Math.sin(beta0), 0];
  const dx = p0[0] - tip[0], dy = p0[1] - tip[1];
  const h2 = g.rodLength ** 2 - dx * dx - dy * dy;
  const homeHeight = h2 > 0 ? Math.sqrt(h2) : NaN;

  return { base, platform, beta, shaftAxis, topStudAxis, homeHeight };
}

/**
 * Inverse kinematics: platform pose to six horn angles.
 *
 * For each leg, with l = P - B (top joint minus horn pivot), the horn angle
 * alpha satisfies M sin(alpha) + N cos(alpha) = L where
 *   L = |l|^2 - (s^2 - a^2)
 *   M = 2a * l_z
 *   N = 2a * (cos(beta) l_x + sin(beta) l_y)
 * so alpha = asin(L / sqrt(M^2 + N^2)) - atan2(N, M).
 */
export function solve(layout: Layout, g: Geometry, lim: Limits, pose: Pose): Solution {
  const R = rotation(pose.roll, pose.pitch, pose.yaw);
  const T: Vec3 = [pose.x, pose.y, layout.homeHeight + pose.z];
  const a = g.hornLength, s = g.rodLength;
  const legs: LegSolution[] = [];

  for (let i = 0; i < 6; i++) {
    const B = layout.base[i]!;
    const beta = layout.beta[i]!;
    const P = add(T, mul(R, layout.platform[i]!));
    const l = sub(P, B);

    const L = dot(l, l) - (s * s - a * a);
    const M = 2 * a * l[2];
    const N = 2 * a * (Math.cos(beta) * l[0] + Math.sin(beta) * l[1]);
    const ratio = L / Math.sqrt(M * M + N * N);

    const faults: LegFault[] = [];
    let alpha = NaN;
    let hornTip: Vec3 = B;
    let swivelBottom = NaN, swivelTop = NaN;

    if (!Number.isFinite(ratio) || Math.abs(ratio) > 1) {
      faults.push("no-solution");
    } else {
      alpha = Math.asin(ratio) - Math.atan2(N, M);
      hornTip = add(B, scale([Math.cos(alpha) * Math.cos(beta), Math.cos(alpha) * Math.sin(beta), Math.sin(alpha)], a));

      const rod = unit(sub(P, hornTip));
      swivelBottom = Math.asin(Math.min(1, Math.abs(dot(rod, layout.shaftAxis[i]!))));
      swivelTop = Math.asin(Math.min(1, Math.abs(dot(rod, mul(R, layout.topStudAxis[i]!)))));

      if (alpha < lim.servoMinDeg * DEG || alpha > lim.servoMaxDeg * DEG) faults.push("servo-range");
      if (swivelBottom > lim.ballSwivelDeg * DEG) faults.push("ball-swivel-bottom");
      if (swivelTop > lim.ballSwivelDeg * DEG) faults.push("ball-swivel-top");
    }

    legs.push({ alpha, pivot: B, hornTip, top: P, swivelBottom, swivelTop, faults });
  }

  return { legs, ok: Number.isFinite(layout.homeHeight) && legs.every((leg) => leg.faults.length === 0) };
}

/** Rod length actually achieved by a solved leg; equals g.rodLength when the solution is right. */
export function rodLengthOf(leg: LegSolution): number {
  return norm(sub(leg.top, leg.hornTip));
}
