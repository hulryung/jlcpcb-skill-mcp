import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JlcClient } from "./jlc/client.js";
import type { JlcClientLike, ToolDeps } from "./tools/common.js";
import { registerSearchParts } from "./tools/search-parts.js";
import { registerSearchPassives } from "./tools/search-passives.js";
import { registerGetPart } from "./tools/get-part.js";
import { registerFindAlternatives } from "./tools/find-alternatives.js";
import { registerAnalyzeKicad } from "./tools/analyze-kicad.js";
import { registerSuggestBomParts } from "./tools/suggest-bom-parts.js";
import { registerEstimateAssemblyCost } from "./tools/estimate-assembly-cost.js";

export type { JlcClientLike } from "./tools/common.js";

export interface BuildServerDeps {
  client?: JlcClientLike;
}

const INSTRUCTIONS = `Tools for choosing JLCPCB assembly parts (LCSC catalog) with cost awareness.

Part tiers and fees:
- basic: pre-loaded on JLCPCB pick&place lines — no loading fee. Always prefer when specs match.
- preferred (Preferred Extended): the $3 loading fee is waived on Economic PCBA.
- extended: one-time $3 loading fee per unique part per order.
LCSC numbers look like "C25804". Stock should comfortably exceed needed quantity
(board_qty × qty_per_board, ideally 5× or more) to survive restock lag.

Typical workflow: analyze_kicad (parse schematic/BOM) → suggest_bom_parts (ranked
candidates + cost) → review needs_review / no_match lines with search_parts,
search_passives, find_alternatives → estimate_assembly_cost for the final picks.`;

export function buildServer(deps: BuildServerDeps = {}): McpServer {
  const client: JlcClientLike = deps.client ?? new JlcClient();
  const toolDeps: ToolDeps = { client };

  const server = new McpServer(
    { name: "jlcpcb-parts", version: "0.1.0" },
    { instructions: INSTRUCTIONS }
  );

  registerSearchParts(server, toolDeps);
  registerSearchPassives(server, toolDeps);
  registerGetPart(server, toolDeps);
  registerFindAlternatives(server, toolDeps);
  registerAnalyzeKicad(server);
  registerSuggestBomParts(server, toolDeps);
  registerEstimateAssemblyCost(server, toolDeps);

  return server;
}
