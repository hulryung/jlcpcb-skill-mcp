import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Candidate, LineSuggestion, Part } from "../types.js";
import { estimateCost, unitPriceAtQty } from "../engine/index.js";
import { err, errorMessage, formatUsd, ok, type ToolDeps } from "./common.js";

export function registerEstimateAssemblyCost(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "estimate_assembly_cost",
    {
      title: "Estimate JLCPCB assembly parts cost",
      description:
        "Estimate the parts side of a JLCPCB assembly order for a chosen set of LCSC parts: component cost using quantity price breaks (at qty = board_qty × qty_per_board) plus one-time loading fees — $3 per unique extended-tier part; basic and preferred (Preferred Extended) parts carry no fee. Does not include PCB fabrication or per-joint assembly charges. Use after finalizing part picks from suggest_bom_parts / find_alternatives.",
      inputSchema: {
        parts: z
          .array(
            z.object({
              lcsc: z.string().describe('LCSC part number, e.g. "C25804"'),
              qty_per_board: z
                .number()
                .int()
                .positive()
                .describe("How many of this part are placed on each board"),
            })
          )
          .min(1)
          .describe("The chosen parts to cost"),
        board_qty: z.number().int().positive().describe("Number of boards to assemble"),
      },
    },
    async ({ parts, board_qty }) => {
      try {
        const suggestions: LineSuggestion[] = [];
        const rows: Array<Record<string, unknown>> = [];
        const notFound: string[] = [];

        // Sequential lookups: getPart calls hit a public API when not cached.
        for (const { lcsc, qty_per_board } of parts) {
          let part: Part | null;
          try {
            part = await deps.client.getPart(lcsc);
          } catch {
            // e.g. getPart("abc") throws on malformed LCSC numbers — skip the
            // token and keep costing the rest instead of aborting the estimate.
            notFound.push(`${lcsc} (invalid LCSC format)`);
            continue;
          }
          if (!part) {
            notFound.push(lcsc);
            continue;
          }
          const needed = board_qty * qty_per_board;
          const unit = unitPriceAtQty(part, needed);
          const warnings: string[] = [];
          if (part.stock < needed) {
            warnings.push(`stock ${part.stock} below needed ${needed}`);
          }
          if (part.tier === "extended") warnings.push("+$3 loading fee (extended)");
          if (unit == null) warnings.push("price unknown");
          const candidate: Candidate = {
            part,
            score: 0,
            reasons: [],
            warnings,
            unitPriceAtQty: unit,
            lineCost: unit == null ? null : unit * needed,
          };
          suggestions.push({
            line: {
              references: [part.lcsc],
              qtyPerBoard: qty_per_board,
              value: part.mfr,
              package: part.package || undefined,
              componentClass: "other",
              dnp: false,
            },
            candidates: [candidate],
            chosen: candidate,
            status: "preassigned",
            notes: [],
          });
          rows.push({
            lcsc: part.lcsc,
            mfr: part.mfr,
            tier: part.tier,
            stock: part.stock,
            qtyPerBoard: qty_per_board,
            needed,
            unitPriceAtQty: unit,
            lineCost: candidate.lineCost,
            warnings,
          });
        }

        if (suggestions.length === 0) {
          return err(`None of the requested parts were found: ${notFound.join(", ")}`);
        }

        const cost = estimateCost(suggestions, board_qty);
        const feeBit =
          cost.extendedCount > 0
            ? `${formatUsd(cost.loadingFees)} loading fees (${cost.extendedCount} extended)`
            : "no loading fees";
        const notFoundBit = notFound.length > 0 ? `; NOT FOUND: ${notFound.join(", ")}` : "";
        return ok(
          `Est. ${formatUsd(cost.total)} for ${board_qty} board${board_qty === 1 ? "" : "s"} — components ${formatUsd(cost.componentCostTotal)} + ${feeBit}, ${formatUsd(cost.perBoard)}/board${notFoundBit}`,
          { boardQty: board_qty, parts: rows, notFound, cost }
        );
      } catch (e) {
        return err(`estimate_assembly_cost failed: ${errorMessage(e)}`);
      }
    }
  );
}
