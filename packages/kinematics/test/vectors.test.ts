import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildLayout, solve, type Geometry, type Limits, type Pose } from "../src/index.ts";

interface VectorFile {
  toleranceRad: number;
  geometry: Geometry;
  limits: Limits;
  homeHeight: number;
  cases: { name: string; pose: Pose; ok: boolean; alphaRad: (number | null)[] }[];
}

const vf: VectorFile = JSON.parse(readFileSync(new URL("../../../test-vectors/ik-v1.json", import.meta.url), "utf8"));
const layout = buildLayout(vf.geometry);

// The same file is the acceptance test for the firmware's C++ IK.
// If this fails after an intentional change, regenerate with `pnpm vectors`
// and make the C++ port pass again.
describe("shared IK test vectors", () => {
  it("match the home height", () => {
    expect(layout.homeHeight).toBeCloseTo(vf.homeHeight, 9);
  });

  for (const c of vf.cases) {
    it(c.name, () => {
      const sol = solve(layout, vf.geometry, vf.limits, c.pose);
      expect(sol.ok).toBe(c.ok);
      sol.legs.forEach((leg, i) => {
        const want = c.alphaRad[i];
        if (want === null) expect(leg.alpha).toBeNaN();
        else expect(Math.abs(leg.alpha - want!)).toBeLessThan(vf.toleranceRad);
      });
    });
  }
});
