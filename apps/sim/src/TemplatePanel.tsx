import { useMemo, useState } from "react";
import { PAPERS, plateDrawing, printHtml, sheetSvg, tile, type PlateKind } from "@stewart/template";
import { useSim } from "./store.ts";

type PaperKey = keyof typeof PAPERS;

const PLATES: { kind: PlateKind; label: string }[] = [
  { kind: "base", label: "Base plate" },
  { kind: "top", label: "Top plate" },
];

/** Local calendar date, YYYY-MM-DD (toISOString would give the UTC date). */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function TemplatePanel({ onBlocked }: { onBlocked: (msg: string) => void }) {
  const s = useSim();
  const [paper, setPaper] = useState<PaperKey>("a4");
  const buildable = Number.isFinite(s.layout.homeHeight);

  const drawings = useMemo(() => {
    if (!buildable) return [];
    const meta = { rigName: s.rig.name, date: today() };
    return PLATES.map((p) => ({ ...p, d: plateDrawing(p.kind, s.geometry, s.rig.collision, meta) }));
  }, [buildable, s.geometry, s.rig.collision, s.rig.name]);

  const print = (kind: PlateKind, label: string) => {
    const d = drawings.find((x) => x.kind === kind)!.d;
    const html = printHtml(`${label} — ${s.rig.name}`, tile(d, PAPERS[paper]), PAPERS[paper]);
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    if (!window.open(url, "_blank")) onBlocked("Pop-up blocked. Allow pop-ups for this page to open the print view.");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  if (!buildable) return <p className="hint">The rods can't reach the platform with this geometry, so there's nothing to drill yet.</p>;

  return (
    <div className="templates">
      <p className="hint">
        1:1 drilling templates for the current geometry. Print at 100% (Actual size), check that both 100 mm scale bars measure 100 mm,
        then spray-mount the sheet on the plate and centre-punch the marks.
      </p>
      <label className="paper">
        Paper
        <select value={paper} onChange={(e) => setPaper(e.target.value as PaperKey)}>
          {Object.entries(PAPERS).map(([k, p]) => (
            <option key={k} value={k}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div className="table-wrap">
        <table className="template-table">
          <tbody>
            {drawings.map(({ kind, label, d }) => {
              const sheets = tile(d, PAPERS[paper]).pages.length;
              return (
                <tr key={kind}>
                  <td>
                    {label}
                    <span className="sub">
                      {Math.round(d.width)} × {Math.round(d.height)} mm · {sheets} sheet{sheets > 1 ? "s" : ""}
                    </span>
                  </td>
                  <td className="num">
                    <button type="button" onClick={() => print(kind, label)}>
                      Print…
                    </button>{" "}
                    <button type="button" className="ghost" onClick={() => download(`${s.rig.name}-${kind}-plate.svg`, sheetSvg(d), "image/svg+xml")}>
                      SVG
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!s.rig.measured && <p className="hint">The rig is still on placeholder dimensions. Measure the parts before cutting plates.</p>}
    </div>
  );
}
