import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JlcClient } from "./jlc/client.js";
import { openDbIfAvailable } from "./jlc/db.js";
import { HybridJlcClient } from "./jlc/hybrid.js";
import { JlcRemoteClient } from "./jlc/remote.js";
import type { JlcClientLike, ToolDeps } from "./tools/common.js";
import { registerSearchParts } from "./tools/search-parts.js";
import { registerSearchPassives } from "./tools/search-passives.js";
import { registerGetPart } from "./tools/get-part.js";
import { registerFindAlternatives } from "./tools/find-alternatives.js";
import { registerAnalyzeKicad } from "./tools/analyze-kicad.js";
import { registerImportPart } from "./tools/import-part.js";
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
search_passives, find_alternatives → estimate_assembly_cost for the final picks.
To make a chosen part usable in a KiCad project, import_part_to_kicad fetches its
symbol/footprint/3D model and registers them in the project's libraries.`;

/**
 * Default data source, in priority order:
 *  1. Local catalog DB present (JLCPCB_PARTS_DB / default cache path) → hybrid
 *     (offline full-catalog search, live API for final stock/tier verification).
 *  2. JLCPCB_API_URL set → our hosted D1 Worker (catalog search, no local download).
 *  3. Otherwise → the live jlcsearch API directly.
 */
function defaultClient(): JlcClientLike {
  const api = new JlcClient();
  const db = openDbIfAvailable(process.env.JLCPCB_PARTS_DB);
  if (db) return new HybridJlcClient(db, api);
  if (process.env.JLCPCB_API_URL) return new JlcRemoteClient({ baseUrl: process.env.JLCPCB_API_URL });
  return api;
}

export function buildServer(deps: BuildServerDeps = {}): McpServer {
  const client: JlcClientLike = deps.client ?? defaultClient();
  const toolDeps: ToolDeps = { client };

  const server = new McpServer(
    { name: "jlcpcb-parts", version: "0.2.0" },
    { instructions: INSTRUCTIONS }
  );

  registerSearchParts(server, toolDeps);
  registerSearchPassives(server, toolDeps);
  registerGetPart(server, toolDeps);
  registerFindAlternatives(server, toolDeps);
  registerAnalyzeKicad(server);
  registerImportPart(server);
  registerSuggestBomParts(server, toolDeps);
  registerEstimateAssemblyCost(server, toolDeps);

  return server;
}
