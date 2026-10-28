import { TopK, scoreGeometry, sweepCandidates, sweepSize, type Collision, type Geometry, type Limits, type SweepRange, type SweepResult } from "@stewart/kinematics";

export interface SweepRequest {
  base: Geometry;
  ranges: SweepRange[];
  limits: Limits;
  collision: Collision;
  keep: number;
}

export type SweepMessage =
  | { type: "progress"; done: number; total: number; best: SweepResult[] }
  | { type: "done"; total: number; best: SweepResult[] };

/** The app compiles against the DOM lib, so describe just the worker globals used here. */
const ctx = self as unknown as { onmessage: (e: MessageEvent<SweepRequest>) => void; postMessage: (m: SweepMessage) => void };

ctx.onmessage = (e) => {
  const { base, ranges, limits, collision, keep } = e.data;
  const total = sweepSize(ranges);
  const top = new TopK(keep);
  let done = 0, last = performance.now();
  for (const g of sweepCandidates(base, ranges)) {
    top.add(scoreGeometry(g, limits, collision));
    done++;
    // Report about five times a second; enough for a smooth bar without flooding the page.
    if (performance.now() - last > 200) {
      last = performance.now();
      ctx.postMessage({ type: "progress", done, total, best: top.items });
    }
  }
  ctx.postMessage({ type: "done", total, best: top.items });
};
