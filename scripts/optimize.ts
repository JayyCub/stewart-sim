/**
 * Finds the best rig designs for the parts in a rig.json.
 *
 * Searches every free geometry and mount parameter at once (differential
 * evolution, then a local polish), scoring each design by weighted reach with
 * collisions counted and servo torque checked. Runs each variant in the
 * config so you can see what extra build effort buys, prints a comparison,
 * and writes the best designs as rig.json files the sim can load.
 *
 * Run:   pnpm optimize                    (all variants, scripts/optimize.config.json)
 *        pnpm optimize --quick            (smaller search, ~6x faster, for trying settings)
 *        pnpm optimize --rig my.json --variant tilt --config other.json
 * Output: optimized/<variant>-<rank>.rig.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  AXES, DEG, TILT_OK, buildLayout, evaluateDesign, nmmToKgCm, optimizeDesign, tiltMap,
  type Axis, type Design, type DesignGoal, type FreeParam, type Geometry,
} from "../packages/kinematics/src/index.ts";
import { defaultRig, parseRigJson, type RigConfig } from "../packages/rig-config/src/index.ts";

interface Config {
  weights: Record<Axis, number>;
  payloadKg: number;
  servoTorqueKgCm: number;
  torqueSafety: number;
  minClearanceMm?: number;
  params: Partial<Record<keyof Geometry, [number, number] | { values: number[] }>>;
  variants: Record<string, { label: string; fixed: Partial<Geometry> }>;
  search: { population: number; generations: number; seed: number; keep: number };
}

const { values: args } = parseArgs({
  // pnpm passes a literal "--" through; drop it so both `pnpm optimize --quick` and `pnpm optimize -- --quick` work.
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    config: { type: "string", default: new URL("./optimize.config.json", import.meta.url).pathname },
    rig: { type: "string" },
    variant: { type: "string" },
    quick: { type: "boolean", default: false },
    out: { type: "string", default: new URL("../optimized/", import.meta.url).pathname },
  },
});

const cfg: Config = JSON.parse(readFileSync(args.config!, "utf8"));
const loaded: RigConfig = args.rig ? parseRigJson(readFileSync(args.rig, "utf8")) : defaultRig;
// The search keeps this gap between servo bodies; written designs carry it so the sim checks the same thing.
const rig: RigConfig = cfg.minClearanceMm === undefined ? loaded : { ...loaded, collision: { ...loaded.collision, minClearance: cfg.minClearanceMm } };
const search = args.quick ? { ...cfg.search, population: 30, generations: 50 } : cfg.search;
const goal: DesignGoal = {
  weights: cfg.weights,
  payloadKg: cfg.payloadKg,
  torqueLimitNmm: cfg.servoTorqueKgCm * cfg.torqueSafety * 9.80665 * 10,
};

const HOME = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };
const tiltArea = (g: Geometry) =>
  tiltMap(buildLayout(g), g, rig.limits, HOME, 35 * DEG, 71, rig.collision).cells.filter((c) => c === TILT_OK).length / 71 ** 2;

const span = (d: Design, ax: Axis) => d.reach[ax].max - d.reach[ax].min;
const deg = (ax: Axis) => ax === "roll" || ax === "pitch" || ax === "yaw";
const row = (label: string, d: Design) => {
  const spans = AXES.map((ax) => (deg(ax) ? span(d, ax) / DEG : span(d, ax)).toFixed(0).padStart(4)).join("");
  const torque = Number.isFinite(d.maxTorqueNmm) ? nmmToKgCm(d.maxTorqueNmm).toFixed(1) : "∞";
  return `${label.padEnd(30)}${d.score.toFixed(3).padStart(7)}${spans}${(tiltArea(d.geometry) * 100).toFixed(0).padStart(6)}%${torque.padStart(8)}`;
};
const header = `${"".padEnd(30)}${"score".padStart(7)}${AXES.map((a) => a.slice(0, 4).padStart(4)).join("")}${"tilt".padStart(7)}${"kg·cm".padStart(8)}`;
const fmtGeo = (g: Geometry) =>
  (Object.keys(cfg.params) as (keyof Geometry)[]).map((k) => `${k} ${+(g[k] ?? 0).toFixed(1)}`).join(" · ");

console.log(`Rig: ${rig.name}${rig.measured ? "" : " (placeholder values; rerun after measuring)"}`);
console.log(`Weights ${AXES.map((a) => `${a} ${cfg.weights[a]}`).join(", ")} · payload ${cfg.payloadKg} kg · servo limit ${(cfg.servoTorqueKgCm * cfg.torqueSafety).toFixed(1)} kg·cm · servo clearance ${rig.collision.minClearance} mm`);
console.log(`Search: population ${search.population}, ${search.generations} generations, seed ${search.seed}${args.quick ? " (quick)" : ""}\n`);

const start = { ...rig.geometry };
const tty = process.stdout.isTTY === true;
const results: { name: string; label: string; designs: Design[] }[] = [];
mkdirSync(args.out!, { recursive: true });

for (const [name, v] of Object.entries(cfg.variants)) {
  if (args.variant && args.variant !== name) continue;
  const base: Geometry = { ...start, ...v.fixed };
  const params: FreeParam[] = (Object.entries(cfg.params) as [keyof Geometry, [number, number] | { values: number[] }][])
    .filter(([k]) => !(k in v.fixed))
    .map(([key, r]) => (Array.isArray(r) ? { key, min: r[0], max: r[1] } : { key, min: Math.min(...r.values), max: Math.max(...r.values), values: r.values }));

  const t0 = performance.now();
  let lastLog = t0;
  // Variants run from most to least constrained; earlier winners that fit this variant seed its search.
  const seeds = results.flatMap((r) => r.designs.map((d) => d.geometry)).filter((g) => Object.entries(v.fixed).every(([k, val]) => (g[k as keyof Geometry] ?? 0) === val));
  const designs = optimizeDesign(base, params, rig.limits, rig.collision, goal, {
    ...search,
    seeds: [start, ...seeds],
    onGeneration: (gen, best) => {
      if (tty && performance.now() - lastLog > 1000) {
        lastLog = performance.now();
        process.stdout.write(`\r\x1b[K  ${name}: generation ${gen + 1}/${search.generations}, best ${best.toFixed(3)}`);
      }
    },
  });
  if (tty) process.stdout.write("\r\x1b[K");
  console.log(`${v.label}: ${params.length} free parameters, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  results.push({ name, label: v.label, designs });

  designs.forEach((d, i) => {
    const out: RigConfig = {
      ...rig,
      name: `opt-${name}-${i + 1}`,
      notes: `pnpm optimize, variant "${name}" #${i + 1}: score ${d.score.toFixed(3)}, max servo torque ${nmmToKgCm(d.maxTorqueNmm).toFixed(1)} kg·cm at ${cfg.payloadKg} kg. Based on ${rig.name}${rig.measured ? "" : " (placeholder values)"}.`,
      geometry: { ...d.geometry },
    };
    writeFileSync(`${args.out}${name}-${i + 1}.rig.json`, JSON.stringify(out, null, 2) + "\n");
  });
}

console.log(`\nSpans: x y z in mm, roll pitch yaw in degrees. tilt = share of the ±35° roll × pitch map reachable at home.`);
console.log(`kg·cm = largest static servo torque over the check poses at ${cfg.payloadKg} kg.\n`);
console.log(header);
console.log(row(`current (${rig.name})`, evaluateDesign(start, rig.limits, rig.collision, goal)));
for (const r of results) r.designs.forEach((d, i) => console.log(row(`${r.name} #${i + 1}`, d)));

console.log("\nBest of each:");
for (const r of results) if (r.designs[0]) console.log(`  ${r.name.padEnd(7)} ${fmtGeo(r.designs[0].geometry)}`);
console.log(`\nWrote ${results.reduce((n, r) => n + r.designs.length, 0)} designs to ${args.out} (load one with "Load rig.json…" in the sim).`);
