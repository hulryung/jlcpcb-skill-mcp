/**
 * Shared helpers for MCP tool implementations: dependency types, result
 * formatting (summary line + fenced JSON), and KiCad file loading.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BomLine, Candidate, ComponentClass, KicadComponent, LineSuggestion, Part } from "../types.js";
import type { PartSearcher } from "../engine/index.js";
import { groupBom, listSheetFiles, parseBomCsv, parseSchematic } from "../kicad/index.js";

/** What the server needs from a JLC client — JlcClient satisfies this. */
export type JlcClientLike = PartSearcher & {
  listCategories(): Promise<{ category: string; subcategory: string }[]>;
  /**
   * Detail lookup via the parametric category endpoint: unlike getPart, the
   * returned Part carries spec attributes (Resistance, Capacitance, Tolerance…).
   * Callers must fall back to getPart attributes when it returns null.
   */
  getPassiveDetail(lcsc: string | number, kind: "resistor" | "capacitor"): Promise<Part | null>;
};

export interface ToolDeps {
  client: JlcClientLike;
}

/** All ComponentClass values, for z.enum. Kept in sync via `satisfies`. */
export const COMPONENT_CLASSES = [
  "resistor",
  "capacitor",
  "inductor",
  "ferrite_bead",
  "diode",
  "led",
  "transistor",
  "ic",
  "crystal",
  "connector",
  "switch",
  "fuse",
  "other",
] as const satisfies readonly ComponentClass[];

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

/** One text block: human summary line, blank line, fenced compact JSON. */
export function ok(summary: string, data: unknown): CallToolResult {
  const json = JSON.stringify(data);
  return {
    content: [{ type: "text", text: `${summary}\n\n\`\`\`json\n${json}\n\`\`\`` }],
  };
}

export function err(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function clampLimit(value: number | undefined, fallback: number): number {
  const v = value ?? fallback;
  return Math.min(50, Math.max(1, Math.floor(v)));
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** 37000000 → "37M", 152000 → "152k", 9800 → "9.8k", 500 → "500". */
export function formatStock(stock: number): string {
  const scale = (n: number): string =>
    n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
  if (stock >= 1_000_000) return `${scale(stock / 1_000_000)}M`;
  if (stock >= 1_000) return `${scale(stock / 1_000)}k`;
  return String(stock);
}

/** "$0.0011", "$1.20", "$13.20" — trailing zeros trimmed on sub-dollar values. */
export function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "$?";
  const abs = Math.abs(n);
  if (abs >= 1 || n === 0) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4).replace(/(\.\d*?[1-9])0+$/, "$1")}`;
}

export function formatOhms(ohms: number): string {
  const scale = (n: number): string => String(Math.round(n * 100) / 100);
  if (ohms >= 1e6) return `${scale(ohms / 1e6)}MΩ`;
  if (ohms >= 1e3) return `${scale(ohms / 1e3)}kΩ`;
  return `${scale(ohms)}Ω`;
}

export function formatFarads(farads: number): string {
  const scale = (n: number): string => String(Math.round(n * 100) / 100);
  if (farads >= 1e-6) return `${scale(farads * 1e6)}µF`;
  if (farads >= 1e-9) return `${scale(farads * 1e9)}nF`;
  return `${scale(farads * 1e12)}pF`;
}

// ---------------------------------------------------------------------------
// JSON payload shapes (stable keys, compact)
// ---------------------------------------------------------------------------

export function partBrief(p: Part) {
  return {
    lcsc: p.lcsc,
    mfr: p.mfr,
    description: p.description,
    package: p.package,
    tier: p.tier,
    stock: p.stock,
    unitPrice: p.unitPrice,
    productUrl: p.productUrl,
  };
}

export function candidateBrief(c: Candidate) {
  return {
    ...partBrief(c.part),
    score: c.score,
    unitPriceAtQty: c.unitPriceAtQty,
    lineCost: c.lineCost,
    reasons: c.reasons,
    warnings: c.warnings,
  };
}

export function lineBrief(line: BomLine) {
  return {
    references: line.references,
    qtyPerBoard: line.qtyPerBoard,
    value: line.value,
    package: line.package,
    class: line.componentClass,
    lcsc: line.lcsc,
    dnp: line.dnp,
    parsed: line.parsed,
  };
}

export function suggestionBrief(s: LineSuggestion) {
  return {
    line: lineBrief(s.line),
    status: s.status,
    chosen: s.chosen ? candidateBrief(s.chosen) : undefined,
    candidates: s.candidates.map(candidateBrief),
    notes: s.notes,
  };
}

// ---------------------------------------------------------------------------
// KiCad file loading (analyze_kicad + suggest_bom_parts)
// ---------------------------------------------------------------------------

export type LoadResult =
  | { ok: true; file: string; components: KicadComponent[]; lines: BomLine[]; warnings: string[] }
  | { ok: false; message: string };

/**
 * Parse a root schematic and recursively follow its hierarchical sheet files
 * (listSheetFiles → Sheetfile names, resolved relative to the including file).
 * Each file is parsed once (cycle-guard on resolved absolute paths); missing
 * or unparseable sheets are skipped with a warning instead of failing.
 */
async function loadSchematicComponents(
  rootAbs: string,
  rootText: string,
  warnings: string[],
): Promise<KicadComponent[]> {
  const components = parseSchematic(rootText);
  const visited = new Set<string>([rootAbs]);
  let followed = 0;
  let repeated = false;

  const follow = async (fromAbs: string, fromText: string): Promise<void> => {
    let sheetNames: string[];
    try {
      sheetNames = listSheetFiles(fromText);
    } catch {
      return; // sheet detection failed — keep what we parsed so far
    }
    for (const name of sheetNames) {
      const sheetAbs = path.resolve(path.dirname(fromAbs), name);
      if (visited.has(sheetAbs)) {
        repeated = true; // multi-instance sheet or an include cycle
        continue;
      }
      visited.add(sheetAbs);
      let sheetText: string;
      try {
        sheetText = await readFile(sheetAbs, "utf8");
      } catch {
        warnings.push(`sheet file not found: ${name} — skipped`);
        continue;
      }
      try {
        components.push(...parseSchematic(sheetText));
      } catch (e) {
        warnings.push(`could not parse sheet ${name} — skipped (${errorMessage(e)})`);
        continue;
      }
      followed += 1;
      await follow(sheetAbs, sheetText);
    }
  };

  await follow(rootAbs, rootText);
  if (followed > 0) warnings.unshift(`followed ${followed} hierarchical sheet(s)`);
  if (repeated) warnings.push("multi-instance sheets are counted once");
  return components;
}

export async function loadBomLinesFromFile(inputPath: string): Promise<LoadResult> {
  const abs = path.resolve(process.cwd(), inputPath);
  const lower = abs.toLowerCase();
  const isSch = lower.endsWith(".kicad_sch");
  const isCsv = lower.endsWith(".csv");
  if (!isSch && !isCsv) {
    return {
      ok: false,
      message: `Unsupported file type: "${path.basename(abs)}" — expected a KiCad schematic (.kicad_sch) or a KiCad BOM CSV export (.csv).`,
    };
  }
  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      ok: false,
      message:
        code === "ENOENT"
          ? `File not found: ${abs}`
          : `Could not read ${abs}: ${errorMessage(e)}`,
    };
  }
  try {
    const warnings: string[] = [];
    const components = isSch
      ? await loadSchematicComponents(abs, text, warnings)
      : parseBomCsv(text);
    const lines = groupBom(components);
    return { ok: true, file: abs, components, lines, warnings };
  } catch (e) {
    return { ok: false, message: `Failed to parse ${path.basename(abs)}: ${errorMessage(e)}` };
  }
}
