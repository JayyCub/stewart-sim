import { describe, expect, it } from "vitest";
import { buildLayout, solve } from "@stewart/kinematics";
import { defaultRig, frameUs, type RigConfig } from "@stewart/rig-config";
import { fitLimits, forwardFromHome, markLogJson, parseMarkLog, type LimitMark, type MarkCause, type MarkKind } from "../src/hardware/limitfit.ts";

/** rig.json with the limits these tests were written against, so they don't move when rig.json does. */
const rig: RigConfig = {
  ...defaultRig,
  limits: { ...defaultRig.limits, servoMinDeg: -75, servoMaxDeg: 70, ballSwivelDeg: 30 },
  collision: { ...defaultRig.collision, hornRodMinDeg: 8 },
};
let n = 0;

/** A mark taken with servo `leg` jogged to `deg` (others level), pulses from `cal`'s calibration. */
function mark(leg: number, deg: number, kind: MarkKind, cause?: MarkCause, cal: RigConfig = rig): LimitMark {
  const a = rig.servos.map((_, i) => (i === leg ? deg : 0));
  return {
    id: `m${n++}`, time: "2026-11-21T00:00:00Z", rigName: rig.name, channel: rig.servos[leg]!.channel,
    label: rig.servos[leg]!.label!, kind, ...(cause ? { cause } : {}), usByChannel: frameUs(cal, a),
  };
}

describe("fitLimits", () => {
  it("suggests the tightest servo stop less the margin, and reports the software overshoot", () => {
    const fit = fitLimits(rig, [mark(0, 60, "max", "horn-stop"), mark(3, 64, "max", "horn-stop")], { deg: 2, mm: 0.5 });
    const s = fit.suggestions.find((x) => x.param === "servoMaxDeg")!;
    expect(s.measured).toBeCloseTo(60, 6);
    expect(s.suggested).toBe(58);
    expect(s.change).toBe("tighter");
    expect(s.servos).toBe(2);
    expect(fit.results[0]!.overshoot).toBeCloseTo(rig.limits.servoMaxDeg - 60, 6);
    expect(fit.rig.limits.servoMaxDeg).toBe(58);
    expect(fit.rig.notes).toMatch(/servoMaxDeg 70 -> 58/);
  });

  it("warns when a looser limit rests on fewer than all six servos", () => {
    const fit = fitLimits(rig, [mark(0, -82, "min", "horn-stop")], { deg: 2, mm: 0.5 });
    const s = fit.suggestions.find((x) => x.param === "servoMinDeg")!;
    expect(s.suggested).toBe(-80);
    expect(s.change).toBe("looser");
    expect(s.warn).toMatch(/1 of 6/);
  });

  it("level marks set trimUs, and later angles are measured from the true level", () => {
    // The real level of servo index 1 is 30 us above centre; the bench rig carries that trim.
    const trimmed: RigConfig = { ...rig, servos: rig.servos.map((s, i) => (i === 1 ? { ...s, trimUs: 30 } : s)) };
    const fit = fitLimits(rig, [mark(1, 0, "level", undefined, trimmed), mark(1, 50, "max", "horn-stop", trimmed)]);
    expect(fit.trims).toEqual([{ leg: 1, label: rig.servos[1]!.label, current: 0, suggested: 30 }]);
    expect(fit.results[0]!.alphaDeg![1]).toBeCloseTo(50, 6);
    expect(fit.rig.servos[1]!.trimUs).toBe(30);
  });

  it.each([
    ["ball-bottom", "ball-swivel-bottom"],
    ["rod-horn", "rod-hits-horn"],
    ["rod-servo", "rod-hits-servo"],
  ] as const)("with no margin, the fitted %s limit stops the model right at the marked contact", (cause, fault) => {
    const leg = 0, deg = -40;
    const fit = fitLimits(rig, [mark(leg, deg, "min", cause)], { deg: 0, mm: 0 });
    expect(fit.suggestions).toHaveLength(1);
    const pose = forwardFromHome(rig, rig.servos.map((_, i) => (i === leg ? deg : 0)))!;
    const layout = buildLayout(rig.geometry);
    const faultsAt = (r: RigConfig) => solve(layout, r.geometry, r.limits, pose, r.collision).legs[leg]!.faults;
    expect(faultsAt(fit.rig)).toContain(fault);
    // Half a step (the rounding) looser and the model no longer flags it there.
    const s = fit.suggestions[0]!;
    const looser = s.param === "ballSwivelDeg" ? s.suggested + 0.5 : s.suggested - (s.param === "rodRadius" ? 0.1 : 0.5);
    const r2: RigConfig = s.param === "ballSwivelDeg"
      ? { ...fit.rig, limits: { ...fit.rig.limits, ballSwivelDeg: looser } }
      : { ...fit.rig, collision: { ...fit.rig.collision, [s.param]: looser } };
    expect(faultsAt(r2)).not.toContain(fault);
  });

  it("says why a binding mark sets no limit", () => {
    const fit = fitLimits(rig, [mark(2, 20, "max", "binding")]);
    expect(fit.suggestions).toHaveLength(0);
    expect(fit.results[0]!.problem).toMatch(/geometry/);
    expect(fit.rig).toBe(rig);
  });
});

describe("mark log", () => {
  it("round-trips through JSON and rejects anything else", () => {
    const marks = [mark(0, 10, "max", "horn-stop"), mark(4, 0, "level")];
    expect(parseMarkLog(markLogJson(marks))).toEqual(marks);
    expect(() => parseMarkLog("{}")).toThrow(/limit-marks/);
    expect(() => parseMarkLog("nope")).toThrow(/JSON/);
    const bad = JSON.parse(markLogJson(marks));
    delete bad.marks[0].cause;
    expect(() => parseMarkLog(JSON.stringify(bad))).toThrow(/Mark 1/);
  });
});

describe("suspect marks", () => {
  it("flags a joint mark far from the current limit as a likely wrong cause or geometry", () => {
    // Leg 2 at -45 deg: the model's lower swivel is small, nowhere near the 30 deg limit.
    const fit = fitLimits(rig, [mark(2, -45, "min", "ball-bottom")]);
    expect(fit.suggestions[0]!.warn).toMatch(/geometry/);
  });
});

describe("clear sweeps", () => {
  const legOf1 = rig.servos.findIndex((s) => s.label === 1);

  it("loosen just the limits that would have stopped the sweep, and the fitted model allows all of it", () => {
    const fit = fitLimits(rig, [mark(legOf1, 85, "clear"), mark(legOf1, -78, "clear")]);
    const by = Object.fromEntries(fit.suggestions.map((s) => [s.param, s]));
    expect(by.servoMaxDeg!.suggested).toBe(85);
    expect(by.servoMinDeg!.suggested).toBe(-78);
    expect(by.servoMaxDeg!.change).toBe("looser");
    expect(by.servoMaxDeg!.warn).toMatch(/1 of 6/);
    expect(fit.results[0]!.sweep!.stoppedAt!.deg).toBeGreaterThan(rig.limits.servoMaxDeg - 1); // stopped by servo range near +70
    // Every sample of both sweeps now passes the fitted model.
    const layout = buildLayout(rig.geometry);
    for (const end of [85, -78]) {
      for (let d = 0; Math.abs(d) <= Math.abs(end); d += Math.sign(end) * 0.5) {
        // 1e-9° inside the end: the limit sits exactly on the cleared angle, where float noise could land either side.
        const dd = d === end ? d - Math.sign(end) * 1e-9 : d;
        const pose = forwardFromHome(rig, rig.servos.map((_, i) => (i === legOf1 ? dd : 0)))!;
        expect(solve(layout, fit.rig.geometry, fit.rig.limits, pose, fit.rig.collision).ok).toBe(true);
      }
    }
  });

  it("never tighten anything", () => {
    const fit = fitLimits(rig, [mark(legOf1, 30, "clear"), mark(legOf1, -30, "clear")]);
    expect(fit.suggestions.every((s) => s.change === "same")).toBe(true);
    expect(fit.rig).toBe(rig);
  });

  it("say where the model loses the pose, and only set the horn range from there on", () => {
    const fit = fitLimits(rig, [mark(legOf1, -99.8, "clear")]);
    const sw = fit.results[0]!.sweep!;
    expect(sw.noPoseFrom).not.toBeNull();
    expect(sw.noPoseFrom!).toBeLessThan(-80);
    expect(fit.suggestions.find((s) => s.param === "servoMinDeg")!.suggested).toBe(-99.8);
  });

  it("warn when a clear sweep went past a marked contact", () => {
    const fit = fitLimits(rig, [mark(0, 60, "max", "horn-stop"), mark(0, 65, "clear")]);
    expect(fit.suggestions.find((s) => s.param === "servoMaxDeg")!.warn).toMatch(/went past a marked contact/);
  });
});
