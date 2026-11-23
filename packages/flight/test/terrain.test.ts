import { describe, expect, it } from "vitest";
import { FlightSim, SCENARIOS, TERRAIN_MAX, groundHeight, rawHeight } from "../src/index.ts";

describe("terrain", () => {
  it("is deterministic and never rises above TERRAIN_MAX (scripted flights cruise at 1000 m)", () => {
    let max = -Infinity, min = Infinity, water = 0, n = 0;
    for (let north = -60000; north <= 60000; north += 450) {
      for (let east = -60000; east <= 60000; east += 450) {
        const h = rawHeight(north, east);
        max = Math.max(max, h);
        min = Math.min(min, h);
        if (h < 0) water++;
        n++;
      }
    }
    expect(max).toBeLessThan(TERRAIN_MAX);
    expect(max).toBeGreaterThan(400); // there are real hills
    expect(water / n).toBeGreaterThan(0.02); // and some lakes
    expect(water / n).toBeLessThan(0.4);
    expect(rawHeight(1234.5, -987.6)).toBe(rawHeight(1234.5, -987.6));
    expect(groundHeight(0, 0)).toBeGreaterThanOrEqual(0);
  });

  it("is continuous: no cliffs between points 10 m apart", () => {
    for (let i = 0; i < 2000; i++) {
      const n = (i * 7919) % 40000 - 20000, e = (i * 104729) % 40000 - 20000;
      expect(Math.abs(rawHeight(n, e) - rawHeight(n + 10, e))).toBeLessThan(25);
    }
  });

  it("a flight that flies into the ground ends there", () => {
    const sim = new FlightSim(SCENARIOS[0], { ground: () => 990 });
    sim.pilot = { ...sim.pilot, pitch: -1, throttle: 1 }; // stick forward
    for (let i = 0; i < 3000 && !sim.telemetry.crashed; i++) sim.tick();
    expect(sim.telemetry.crashed).toBe(true);
    const t = sim.telemetry.t;
    sim.tick();
    expect(sim.telemetry.t).toBe(t); // frozen after the crash
  });
});
