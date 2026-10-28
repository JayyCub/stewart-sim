import { describe, expect, it } from "vitest";
import { DEFAULT_COLLISION as C, buildLayout, servoClashes, type Geometry } from "@stewart/kinematics";
import { HOLE_DIAMETER, PAPERS, PLATE_MARGIN, plateDrawing, printHtml, sheetSvg, tile } from "../src/index.ts";

const geo: Geometry = {
  baseRadius: 85, platformRadius: 60, baseHalfAngleDeg: 15, platformHalfAngleDeg: 30, hornLength: 22, rodLength: 120,
};
const meta = { rigName: "test <rig> & co", date: "2026-10-27" };
const base = plateDrawing("base", geo, C, meta);
const top = plateDrawing("top", geo, C, meta);
const layout = buildLayout(geo);

const attrs = (svg: string, cls: string) =>
  [...svg.matchAll(new RegExp(`<[a-z]+ class="${cls}"([^>]*)>`, "g"))].map((m) =>
    Object.fromEntries([...m[1]!.matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1]!, a[2]!])),
  );

describe("1:1 scale", () => {
  it("sizes the SVG in millimetres with a matching viewBox", () => {
    const svg = sheetSvg(top);
    const [, w, h] = svg.match(/width="([\d.]+)mm" height="([\d.]+)mm" viewBox="0 0 ([\d.]+) ([\d.]+)"/)!.slice(0, 3);
    const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!;
    expect(Number(w)).toBe(Number(vb[1]));
    expect(Number(h)).toBe(Number(vb[2]));
  });

  it("has one horizontal and one vertical scale bar, each exactly 100 mm", () => {
    for (const d of [base, top]) {
      const bars = attrs(d.body, "scale").map((a) => ({ dx: Number(a.x2) - Number(a.x1), dy: Number(a.y2) - Number(a.y1) }));
      expect(bars).toHaveLength(2);
      expect(bars).toContainEqual({ dx: 100, dy: 0 });
      expect(bars).toContainEqual({ dx: 0, dy: 100 });
    }
  });
});

describe("top plate", () => {
  const holes = attrs(top.body, "hole");
  const outline = attrs(top.body, "outline")[0]!;
  const cx = Number(outline.cx), cy = Number(outline.cy);

  it("draws six M3 holes at the platform joint positions, viewed from above", () => {
    expect(holes).toHaveLength(6);
    holes.forEach((h, i) => {
      const p = layout.platform[i]!;
      expect(Number(h.r) * 2).toBe(HOLE_DIAMETER);
      expect(Number(h.cx) - cx).toBeCloseTo(p[0], 3);
      expect(cy - Number(h.cy)).toBeCloseTo(p[1], 3); // y up on the plate is up the page
      expect(Math.hypot(Number(h.cx) - cx, Number(h.cy) - cy)).toBeCloseTo(geo.platformRadius, 3);
    });
  });

  it("puts the outline at the platform radius plus the plate margin", () => {
    expect(Number(outline.r)).toBe(geo.platformRadius + PLATE_MARGIN.top);
  });
});

describe("base plate", () => {
  it("marks six horn pivots on the base radius", () => {
    const pivots = attrs(base.body, "pivot");
    expect(pivots).toHaveLength(6);
    pivots.forEach((p, i) => {
      expect(Number(p["data-x"])).toBeCloseTo(layout.base[i]![0], 3);
      expect(Math.hypot(Number(p["data-x"]), Number(p["data-y"]))).toBeCloseTo(geo.baseRadius, 3);
    });
  });

  it("draws servo footprints that fit inside the plate", () => {
    const outline = attrs(base.body, "outline")[0]!;
    const cx = Number(outline.cx), cy = Number(outline.cy), R = Number(outline.r);
    const servos = attrs(base.body, "servo");
    expect(servos).toHaveLength(6);
    for (const s of servos)
      for (const pt of s.points!.split(" ")) {
        const [x, y] = pt.split(",").map(Number);
        expect(Math.hypot(x! - cx, y! - cy)).toBeLessThan(R);
      }
    expect(servoClashes(layout, C)).toEqual([]);
  });

  it("escapes the rig name", () => {
    expect(base.body).toContain("test &lt;rig&gt; &amp; co");
    expect(base.body).not.toContain("<rig>");
  });
});

describe("tiling", () => {
  it("fits the top plate on one A4 sheet", () => {
    expect(tile(top, PAPERS.a4).pages).toHaveLength(1);
  });

  it("splits the wider base plate across overlapping sheets that cover the whole drawing", () => {
    const t = tile(base, PAPERS.a4);
    expect(t.pages.length).toBeGreaterThan(1);
    const step = t.areaWidth - t.overlap;
    expect((t.cols - 1) * step + t.areaWidth).toBeGreaterThanOrEqual(base.width);
    expect((t.rows - 1) * (t.areaHeight - t.overlap) + t.areaHeight).toBeGreaterThanOrEqual(base.height);
    expect(t.pages[0]!.svg).toContain('class="registration"');
  });

  it("keeps every sheet at 1:1", () => {
    for (const p of tile(base, PAPERS.letter).pages) {
      const m = p.svg.match(/width="([\d.]+)mm" height="([\d.]+)mm" viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/)!;
      expect(m[1]).toBe(m[3]);
      expect(m[2]).toBe(m[4]);
    }
  });

  it("builds a printable page with one section per sheet", () => {
    const t = tile(base, PAPERS.a4);
    const html = printHtml("Base plate", t, PAPERS.a4);
    expect(html.match(/<section class="sheet">/g)).toHaveLength(t.pages.length);
    expect(html).toContain("@page { size: 210mm 297mm; margin: 0; }");
  });
});
