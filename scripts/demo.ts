/**
 * End-to-end demo: parse the example KiCad schematic, match every BOM line to
 * JLCPCB parts via the live jlcsearch API, and print a suggested BOM with cost.
 *
 *   npm run demo [-- <path-to-.kicad_sch-or-.csv>] [--qty 20]
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { analyzeKicadFile } from "../src/kicad/index.js";
import { JlcClient } from "../src/jlc/client.js";
import { suggestForBom, DEFAULT_SUGGEST_OPTIONS } from "../src/engine/index.js";
import type { LineSuggestion } from "../src/types.js";

const args = process.argv.slice(2);
const qtyIdx = args.indexOf("--qty");
const boardQty = qtyIdx >= 0 ? Number(args[qtyIdx + 1]) : 20;
const fileArg = args.find((a, i) => !a.startsWith("--") && (qtyIdx === -1 || i !== qtyIdx + 1));
const path = resolve(fileArg ?? "examples/esp32c3-sensor/esp32c3-sensor.kicad_sch");

const money = (n: number | null | undefined) =>
  n == null ? "?" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;

const text = await readFile(path, "utf8");
const lines = analyzeKicadFile(text, path);
console.log(`Parsed ${lines.length} BOM lines from ${path}\n`);

const client = new JlcClient();
const suggestion = await suggestForBom(lines, client, {
  ...DEFAULT_SUGGEST_OPTIONS,
  boardQty,
});

console.log(`## Suggested BOM (${boardQty} boards)\n`);
console.log("| Refs | Qty | Value | Pkg | LCSC | MPN | Tier | Stock | Unit | Line | Status |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const ls of suggestion.lines as LineSuggestion[]) {
  const c = ls.chosen;
  const p = c?.part;
  console.log(
    `| ${ls.line.references.join(" ")} | ${ls.line.qtyPerBoard} | ${ls.line.value} | ${
      ls.line.package ?? ""
    } | ${p?.lcsc ?? "—"} | ${p?.mfr ?? "—"} | ${p?.tier ?? "—"} | ${
      p ? p.stock.toLocaleString() : "—"
    } | ${money(c?.unitPriceAtQty)} | ${money(c?.lineCost)} | ${ls.status} |`,
  );
}

const cost = suggestion.cost;
console.log(`\n### Cost (${cost.boardQty} boards)`);
console.log(`- Components: ${money(cost.componentCostTotal)}`);
console.log(
  `- Loading fees: ${money(cost.loadingFees)} (${cost.extendedCount} extended, ${cost.preferredCount} preferred, ${cost.basicCount} basic)`,
);
console.log(`- Total: ${money(cost.total)}  (${money(cost.perBoard)}/board)`);

if (suggestion.notes.length) {
  console.log("\n### Notes");
  for (const n of suggestion.notes) console.log(`- ${n}`);
}
for (const ls of suggestion.lines as LineSuggestion[]) {
  if (ls.status === "needs_review" || ls.status === "no_match") {
    console.log(`\n[${ls.status}] ${ls.line.references.join(" ")} ${ls.line.value}: ${ls.notes.join("; ")}`);
    for (const cand of ls.candidates.slice(0, 3)) {
      console.log(`  - ${cand.part.lcsc} ${cand.part.mfr} (${cand.part.tier}, stock ${cand.part.stock.toLocaleString()})`);
    }
  }
}
