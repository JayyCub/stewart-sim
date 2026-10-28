import { buildLayout, servoCorners, servoFrame, type Collision, type Geometry, type Vec3 } from "@stewart/kinematics";

/**
 * 1:1 drilling templates for the base and top plates.
 *
 * Everything is drawn in millimetres: an SVG whose width and height are given
 * in mm and whose viewBox uses the same numbers prints at true size when the
 * printer scale is 100%. Each template carries a horizontal and a vertical
 * 100 mm scale bar, since printers can stretch one direction and not the other.
 *
 * Plates are drawn as seen from above (z up, +x to the right, +y up the page).
 */

/** Plate edge beyond the joint circle, mm. The 3D view uses the same margins. */
export const PLATE_MARGIN = { base: 22, top: 14 } as const;

/** Top ball-joint hole, mm (M3 bolt). */
export const HOLE_DIAMETER = 3;

export type PlateKind = "base" | "top";

export interface Drawing {
  kind: PlateKind;
  /** Drawing size, mm. */
  width: number;
  height: number;
  /** SVG elements in drawing coordinates (mm, y down). */
  body: string;
}

export interface Paper {
  name: string;
  width: number;
  height: number;
}

export const PAPERS: Record<"a4" | "letter", Paper> = {
  a4: { name: "A4", width: 210, height: 297 },
  letter: { name: "US Letter", width: 215.9, height: 279.4 },
};

export interface TemplateMeta {
  rigName: string;
  /** Shown in the title block, e.g. "2026-10-27". */
  date: string;
}

const f = (n: number) => String(Math.round(n * 1000) / 1000);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const STROKE = 'stroke="#000" fill="none"';
const TEXT = 'font-family="Helvetica, Arial, sans-serif" fill="#000"';

function cross(x: number, y: number, size: number, width = 0.2) {
  return `<path d="M${f(x - size)} ${f(y)}H${f(x + size)}M${f(x)} ${f(y - size)}V${f(y + size)}" ${STROKE} stroke-width="${width}"/>`;
}

function text(x: number, y: number, s: string, size = 3.2, anchor: "start" | "middle" | "end" = "start", extra = "") {
  return `<text x="${f(x)}" y="${f(y)}" font-size="${size}" text-anchor="${anchor}" ${TEXT}${extra}>${esc(s)}</text>`;
}

/** 100 mm bar with 10 mm ticks. Horizontal bars start at (x, y); vertical bars run down from (x, y). */
function scaleBar(x: number, y: number, vertical: boolean) {
  const parts: string[] = [];
  const at = (d: number): [number, number] => (vertical ? [x, y + d] : [x + d, y]);
  const [x2, y2] = at(100);
  parts.push(`<line class="scale" x1="${f(x)}" y1="${f(y)}" x2="${f(x2)}" y2="${f(y2)}" ${STROKE} stroke-width="0.3"/>`);
  for (let d = 0; d <= 100; d += 10) {
    const len = d % 50 === 0 ? 4 : 2;
    const [tx, ty] = at(d);
    parts.push(
      vertical
        ? `<line x1="${f(tx)}" y1="${f(ty)}" x2="${f(tx + len)}" y2="${f(ty)}" ${STROKE} stroke-width="0.25"/>`
        : `<line x1="${f(tx)}" y1="${f(ty)}" x2="${f(tx)}" y2="${f(ty - len)}" ${STROKE} stroke-width="0.25"/>`,
    );
  }
  if (vertical) {
    parts.push(text(x + 5, y + 2, "0", 2.6), text(x + 5, y + 51, "50", 2.6), text(x + 5, y + 101, "100 mm", 2.6));
  } else {
    parts.push(text(x, y + 4, "0", 2.6, "middle"), text(x + 50, y + 4, "50", 2.6, "middle"), text(x + 100, y + 4, "100 mm", 2.6, "middle"));
  }
  return parts.join("");
}

/** Convex hull of 2D points (monotone chain), counter-clockwise. */
function hull2(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const turn = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: [number, number][]) => {
    const h: [number, number][] = [];
    for (const q of list) {
      while (h.length >= 2 && turn(h[h.length - 2]!, h[h.length - 1]!, q) <= 1e-9) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  return [...half(p), ...half([...p].reverse())];
}

/**
 * Draw one plate. The base shows each servo's body footprint, its horn pivot
 * (the shaft axis where it meets the horn plane) and the horn plane itself.
 * The top shows the six ball-joint holes.
 */
export function plateDrawing(kind: PlateKind, g: Geometry, col: Collision, meta: TemplateMeta): Drawing {
  const layout = buildLayout(g);
  const R = (kind === "base" ? g.baseRadius : g.platformRadius) + PLATE_MARGIN[kind];
  const m = 6;
  const left = m + 16; // room for the vertical scale bar
  const cx = left + R;
  const cy = m + R;
  const P = (p: Vec3 | [number, number]): [number, number] => [cx + p[0], cy - p[1]];
  const parts: string[] = [];

  // Plate outline, centre mark, +x direction.
  parts.push(`<circle class="outline" cx="${f(cx)}" cy="${f(cy)}" r="${f(R)}" ${STROKE} stroke-width="0.35"/>`);
  parts.push(cross(cx, cy, 6), `<circle cx="${f(cx)}" cy="${f(cy)}" r="0.75" ${STROKE} stroke-width="0.2"/>`);
  parts.push(`<path d="M${f(cx + 10)} ${f(cy)}H${f(cx + 28)}M${f(cx + 25)} ${f(cy - 1.5)}L${f(cx + 28)} ${f(cy)}L${f(cx + 25)} ${f(cy + 1.5)}" ${STROKE} stroke-width="0.3"/>`);
  parts.push(text(cx + 30, cy + 1.1, "+x", 3.2));
  // Edge notch at +x, as on the 3D model.
  parts.push(`<path d="M${f(cx + R - 4)} ${f(cy)}H${f(cx + R)}" ${STROKE} stroke-width="0.6"/>`);

  if (kind === "base") {
    layout.base.forEach((B, i) => {
      const fr = servoFrame(layout, i);
      const at = (r: number, sv: number): [number, number] => P([B[0] + fr.r[0] * r + fr.s[0] * sv, B[1] + fr.r[1] * r + fr.s[1] * sv]);
      // Footprint: the outline of the body seen from above (exact for upright servos, the shadow of a tilted one).
      const quad = hull2(servoCorners(fr, col).map((p) => P(p)));
      parts.push(`<polygon class="servo" data-leg="${i + 1}" points="${quad.map((q) => q.map(f).join(",")).join(" ")}" ${STROKE} stroke-width="0.3"/>`);
      // Horn plane: where the horn swings, drawn on the side the horn points (away from its pair partner).
      const [ha, hb] = [at(0, -4), at(0, g.hornLength + 4)];
      parts.push(`<line x1="${f(ha[0])}" y1="${f(ha[1])}" x2="${f(hb[0])}" y2="${f(hb[1])}" ${STROKE} stroke-width="0.2" stroke-dasharray="1.5 1"/>`);
      const [px, py] = P(B);
      parts.push(`<g class="pivot" data-leg="${i + 1}" data-x="${f(B[0])}" data-y="${f(B[1])}">${cross(px, py, 3)}</g>`);
      const out = Math.hypot(B[0], B[1]);
      const [lx, ly] = P([(B[0] * (out + 12)) / out, (B[1] * (out + 12)) / out]);
      parts.push(text(lx, ly + 1.2, String(i + 1), 3.4, "middle", ' font-weight="bold"'));
    });
  } else {
    layout.platform.forEach((p, i) => {
      const [hx, hy] = P(p);
      parts.push(`<circle class="hole" data-leg="${i + 1}" data-x="${f(p[0])}" data-y="${f(p[1])}" cx="${f(hx)}" cy="${f(hy)}" r="${f(HOLE_DIAMETER / 2)}" ${STROKE} stroke-width="0.25"/>`);
      parts.push(cross(hx, hy, 4));
      const d = Math.hypot(p[0], p[1]);
      const [lx, ly] = P([(p[0] * (d + 7)) / d, (p[1] * (d + 7)) / d]);
      parts.push(text(lx, ly + 1.2, String(i + 1), 3.4, "middle", ' font-weight="bold"'));
    });
  }

  // Scale bars: vertical beside the plate, horizontal below it.
  const vTop = Math.max(m, cy - 50);
  parts.push(scaleBar(m + 4, vTop, true));
  let y = Math.max(cy + R, vTop + 100) + 10;
  parts.push(scaleBar(left, y, false));
  y += 12;

  const lines =
    kind === "base"
      ? [
          `BASE PLATE — ${meta.rigName} — ${meta.date}`,
          `Base radius ${f(g.baseRadius)} mm · servo pair half-spacing ${f(g.baseHalfAngleDeg)}° · horn ${f(g.hornLength)} mm` +
            (g.servoYawDeg || g.servoTiltDeg ? ` · servo turn ${f(g.servoYawDeg ?? 0)}°, tilt ${f(g.servoTiltDeg ?? 0)}°` : ""),
          g.servoTiltDeg
            ? `Outlines: each tilted servo body seen from above (it sits on a ${f(Math.abs(g.servoTiltDeg))}° wedge), shaft facing out.`
            : `Rectangles: servo body footprints (${f(col.servoDepth)} × ${f(col.servoWidth)} mm), shaft facing out.`,
          "+ marks: horn pivot (shaft centre at the horn face). Dashed: the plane the horn swings in.",
          "Print at 100% / Actual size. Both scale bars must measure 100 mm before you drill.",
        ]
      : [
          `TOP PLATE — ${meta.rigName} — ${meta.date}`,
          `Platform radius ${f(g.platformRadius)} mm · top joint half-spacing ${f(g.platformHalfAngleDeg)}°` +
            (g.topStudTiltDeg ? ` · stud tilt ${f(g.topStudTiltDeg)}°` : ""),
          `Holes: ${f(HOLE_DIAMETER)} mm for the top ball joints. Leg numbers match the base plate.`,
          "Fit with +x over the base plate's +x.",
          "Print at 100% / Actual size. Both scale bars must measure 100 mm before you drill.",
        ];
  lines.forEach((s, k) => parts.push(text(left, y + k * 5, s, k === 0 ? 3.6 : 3, "start", k === 0 ? ' font-weight="bold"' : "")));
  y += (lines.length - 1) * 5 + m;

  return { kind, width: cx + R + m, height: y, body: parts.join("\n") };
}

/** The whole drawing as one SVG file at 1:1, for a print shop or a laser cutter. */
export function sheetSvg(d: Drawing): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${f(d.width)}mm" height="${f(d.height)}mm" viewBox="0 0 ${f(d.width)} ${f(d.height)}">
<rect width="100%" height="100%" fill="#fff"/>
${d.body}
</svg>
`;
}

export interface Page {
  /** SVG for the printable area of one sheet. */
  svg: string;
  row: number;
  col: number;
}

export interface Tiling {
  pages: Page[];
  rows: number;
  cols: number;
  /** Printable area per sheet, mm. */
  areaWidth: number;
  areaHeight: number;
  margin: number;
  overlap: number;
}

const tileCount = (size: number, area: number, overlap: number) => (size <= area ? 1 : Math.ceil((size - overlap) / (area - overlap)));

/**
 * Split a drawing across sheets of paper. Neighbouring sheets overlap by
 * `overlap` mm, and registration crosses run down the middle of each overlap
 * so the sheets can be lined up and taped.
 */
export function tile(d: Drawing, paper: Paper, margin = 10, overlap = 16): Tiling {
  const aw = paper.width - 2 * margin, ah = paper.height - 2 * margin;
  const cols = tileCount(d.width, aw, overlap), rows = tileCount(d.height, ah, overlap);
  const sx = aw - overlap, sy = ah - overlap;

  const marks: string[] = [];
  for (let c = 1; c < cols; c++) for (let y = 10; y < d.height; y += 30) marks.push(cross(c * sx + overlap / 2, y, 3, 0.25));
  for (let r = 1; r < rows; r++) for (let x = 10; x < d.width; x += 30) marks.push(cross(x, r * sy + overlap / 2, 3, 0.25));
  const body = d.body + (marks.length ? `\n<g class="registration">${marks.join("")}</g>` : "");

  const pages: Page[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x0 = col * sx, y0 = row * sy;
      pages.push({
        row,
        col,
        svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${f(aw)}mm" height="${f(ah)}mm" viewBox="${f(x0)} ${f(y0)} ${f(aw)} ${f(ah)}">${body}</svg>`,
      });
    }
  }
  return { pages, rows, cols, areaWidth: aw, areaHeight: ah, margin, overlap };
}

/** A self-contained HTML page that prints the tiled template, one sheet per page. */
export function printHtml(title: string, t: Tiling, paper: Paper): string {
  const n = t.pages.length;
  const sheets = t.pages
    .map(
      (p, i) => `<section class="sheet">
  ${p.svg}
  <div class="label">${esc(title)} · sheet ${i + 1} of ${n}${n > 1 ? ` (row ${p.row + 1}, column ${p.col + 1})` : ""}</div>
</section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  @page { size: ${f(paper.width)}mm ${f(paper.height)}mm; margin: 0; }
  html, body { margin: 0; background: #e8ebee; font: 14px Helvetica, Arial, sans-serif; color: #1a2027; }
  .bar { position: sticky; top: 0; padding: 12px 16px; background: #fff; border-bottom: 1px solid #d0d7de; }
  .bar p { margin: 0 0 8px; max-width: 70ch; }
  .bar button { font: inherit; padding: 6px 14px; }
  .sheet { position: relative; width: ${f(paper.width)}mm; height: ${f(paper.height)}mm; padding: ${f(t.margin)}mm; box-sizing: border-box; margin: 16px auto; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.2); overflow: hidden; }
  .sheet svg { display: block; }
  .label { position: absolute; left: ${f(t.margin)}mm; bottom: ${f(t.margin / 2 - 1.5)}mm; font-size: 8pt; color: #333; }
  @media print {
    html, body { background: #fff; }
    .bar { display: none; }
    .sheet { margin: 0; box-shadow: none; break-after: page; }
  }
</style>
</head>
<body>
<div class="bar">
  <p><strong>${esc(title)}</strong>: ${n} ${paper.name} sheet${n > 1 ? "s" : ""}. In the print dialog choose <strong>${paper.name}</strong>, scale <strong>100% / Actual size</strong> (not "Fit to page"), margins <strong>None</strong>.
  Measure both 100 mm scale bars before drilling.${n > 1 ? ` Sheets overlap by ${f(t.overlap)} mm: trim one edge and line up the + marks.` : ""}</p>
  <button type="button" onclick="window.print()">Print</button>
</div>
${sheets}
</body>
</html>
`;
}
