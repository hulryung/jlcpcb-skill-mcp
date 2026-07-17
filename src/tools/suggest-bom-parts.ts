import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BomLine, ComponentClass, LineStatus, SuggestOptions } from "../types.js";
import { DEFAULT_SUGGEST_OPTIONS, suggestForBom } from "../engine/index.js";
import { parseValue } from "../kicad/index.js";
import {
  COMPONENT_CLASSES,
  clampLimit,
  err,
  errorMessage,
  formatUsd,
  loadBomLinesFromFile,
  ok,
  suggestionBrief,
  type ToolDeps,
} from "./common.js";

const bomLineRow = z.object({
  value: z.string().describe('Component value, e.g. "10k", "100nF", "AMS1117-3.3", "ESP32-C3"'),
  package: z.string().optional().describe('JLC package name, e.g. "0603", "SOT-23-5", "SOIC-8"'),
  qty: z.number().int().positive().optional().describe("Quantity per board (default 1)"),
  class: z
    .enum(COMPONENT_CLASSES)
    .optional()
    .describe(
      'Component class. When omitted it is inferred from the value: resistance-like values ("10k", "4k7", "470R", bare numbers like "10") → resistor; capacitance-like ("100nF", "4u7", "0.1uF") → capacitor; frequency-like ("8MHz", "32.768kHz") → crystal; anything else (e.g. "NE555") → other, matched by free-text search. Pass the class explicitly when that inference would be wrong.'
    ),
});

export function registerSuggestBomParts(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "suggest_bom_parts",
    {
      title: "Suggest JLCPCB parts for a BOM",
      description:
        "Suggest concrete JLCPCB parts for a whole BOM with assembly-cost awareness. Input EITHER 'path' (a .kicad_sch schematic or KiCad BOM .csv) OR 'bom_lines' (inline rows) — exactly one. Each line gets ranked candidates with reasons/warnings and a status: matched, needs_review (verify manually — e.g. IC matched only by fuzzy text), no_match, preassigned (schematic already carries an LCSC number), or skipped_dnp. Also returns a cost breakdown: component cost at price breaks plus one-time $3 loading fee per unique extended-tier part (basic and preferred parts are fee-free). Ranking prefers basic tier, deep stock vs. needed qty (board_qty × qty × stock_multiple), and lower price.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Path to a .kicad_sch or BOM .csv (mutually exclusive with bom_lines). Relative paths resolve against the server's working directory."
          ),
        bom_lines: z
          .array(bomLineRow)
          .min(1)
          .optional()
          .describe("Inline BOM lines (mutually exclusive with path)"),
        board_qty: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Number of boards to assemble (default ${DEFAULT_SUGGEST_OPTIONS.boardQty})`),
        stock_multiple: z
          .number()
          .positive()
          .optional()
          .describe(
            `Stock safety factor: warn unless stock ≥ needed × this (default ${DEFAULT_SUGGEST_OPTIONS.stockMultiple})`
          ),
        max_candidates: z
          .number()
          .int()
          .optional()
          .describe(
            `Ranked candidates kept per line, clamped to 1-50 (default ${DEFAULT_SUGGEST_OPTIONS.maxCandidates})`
          ),
      },
    },
    async ({ path: inputPath, bom_lines, board_qty, stock_multiple, max_candidates }) => {
      if ((inputPath && bom_lines) || (!inputPath && !bom_lines)) {
        return err(
          "Provide exactly one of 'path' (KiCad schematic or BOM CSV) or 'bom_lines' (inline rows)."
        );
      }

      let lines: BomLine[];
      let file: string | undefined;
      let fileWarnings: string[] = [];
      if (inputPath) {
        const loaded = await loadBomLinesFromFile(inputPath);
        if (!loaded.ok) return err(loaded.message);
        lines = loaded.lines;
        file = loaded.file;
        fileWarnings = loaded.warnings;
      } else {
        lines = (bom_lines ?? []).map(inlineRowToBomLine);
      }
      if (lines.length === 0) {
        return err("No BOM lines to suggest for — the input parsed to an empty BOM.");
      }

      const opts: SuggestOptions = {
        boardQty: board_qty ?? DEFAULT_SUGGEST_OPTIONS.boardQty,
        stockMultiple: stock_multiple ?? DEFAULT_SUGGEST_OPTIONS.stockMultiple,
        maxCandidates: clampLimit(max_candidates, DEFAULT_SUGGEST_OPTIONS.maxCandidates),
      };

      try {
        const result = await suggestForBom(lines, deps.client, opts);
        const counts = countStatuses(result.lines.map((l) => l.status));
        const statusBits = [
          `${counts.matched} matched`,
          counts.preassigned > 0 ? `${counts.preassigned} preassigned` : null,
          counts.needs_review > 0 ? `${counts.needs_review} needs review` : null,
          counts.no_match > 0 ? `${counts.no_match} no match` : null,
          counts.skipped_dnp > 0 ? `${counts.skipped_dnp} DNP skipped` : null,
        ].filter(Boolean);
        const c = result.cost;
        const summary =
          `${lines.length} BOM line${lines.length === 1 ? "" : "s"} for ${opts.boardQty} board${opts.boardQty === 1 ? "" : "s"}: ` +
          `${statusBits.join(", ")} — est. ${formatUsd(c.total)} total (${formatUsd(c.perBoard)}/board, ${formatUsd(c.loadingFees)} loading fees)` +
          (fileWarnings.length > 0 ? ` — ${fileWarnings.join("; ")}` : "");
        return ok(summary, {
          file,
          boardQty: opts.boardQty,
          lines: result.lines.map(suggestionBrief),
          cost: result.cost,
          notes: [...fileWarnings, ...result.notes],
        });
      } catch (e) {
        return err(`suggest_bom_parts failed: ${errorMessage(e)}`);
      }
    }
  );
}

/**
 * Infer a component class from a bare value string. Runs the value through the
 * resistance and capacitance parsers: exactly one hit wins; explicit units
 * disambiguate ("100nF" → capacitor, "470R" → resistor); a bare number ("10")
 * only parses as a resistance and lands on resistor; the rare both-parse case
 * (e.g. "100m") follows resistor convention. Frequency-like values ("8MHz")
 * become crystal; everything else stays "other" (free-text search).
 */
function inferClassFromValue(value: string): ComponentClass {
  const isResistance = parseValue(value, "resistor").kind === "resistance";
  const isCapacitance = parseValue(value, "capacitor").kind === "capacitance";
  if (isResistance) return "resistor";
  if (isCapacitance) return "capacitor";
  if (parseValue(value, "crystal").kind === "frequency") return "crystal";
  return "other";
}

function inlineRowToBomLine(row: z.infer<typeof bomLineRow>): BomLine {
  const cls: ComponentClass = row.class ?? inferClassFromValue(row.value);
  return {
    references: [],
    qtyPerBoard: row.qty ?? 1,
    value: row.value,
    package: row.package,
    componentClass: cls,
    parsed: parseValue(row.value, cls),
    dnp: false,
  };
}

function countStatuses(statuses: LineStatus[]): Record<LineStatus, number> {
  const counts: Record<LineStatus, number> = {
    matched: 0,
    needs_review: 0,
    no_match: 0,
    preassigned: 0,
    skipped_dnp: 0,
  };
  for (const s of statuses) counts[s] += 1;
  return counts;
}
