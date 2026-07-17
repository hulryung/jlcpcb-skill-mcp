import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  clampLimit,
  err,
  errorMessage,
  formatStock,
  ok,
  partBrief,
  plural,
  type ToolDeps,
} from "./common.js";

export function registerSearchParts(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "search_parts",
    {
      title: "Search JLCPCB parts",
      description:
        "Free-text search of the JLCPCB/LCSC parts catalog. Use for ICs, connectors, LEDs, diodes, or any part by keyword, value+package text, or manufacturer part number (e.g. \"AMS1117-3.3\", \"10k 0603\", \"USB-C 16pin\"). For resistors/capacitors by exact value prefer search_passives. Tier semantics: basic = pre-loaded at JLCPCB, no loading fee; preferred = Preferred Extended, $3 loading fee waived (Economic PCBA); extended = one-time $3 loading fee per unique part per order.",
      inputSchema: {
        query: z
          .string()
          .describe(
            'Free-text query: keywords, value + package, or manufacturer part number (e.g. "10k 0603", "ESP32-C3", "WS2812B")'
          ),
        package: z
          .string()
          .optional()
          .describe('Filter by JLC package name, e.g. "0603", "SOT-23-5", "SOIC-8", "QFN-32"'),
        tier: z
          .enum(["basic", "preferred", "extended"])
          .optional()
          .describe(
            "Tier filter with admit-lower semantics — NOT an exact-tier match. 'basic' or 'preferred' both return only fee-free parts (basic and preferred-extended, no $3 loading fee); 'extended' applies no filtering and returns parts of all tiers. Check each result's tier field for its actual tier."
          ),
        min_stock: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Only return parts with at least this much JLCPCB stock"),
        limit: z.number().int().optional().describe("Max results, clamped to 1-50 (default 10)"),
      },
    },
    async ({ query, package: pkg, tier, min_stock, limit }) => {
      try {
        const parts = await deps.client.searchComponents({
          q: query,
          package: pkg,
          tier,
          minStock: min_stock,
          limit: clampLimit(limit, 10),
        });
        if (parts.length === 0) {
          return ok(
            `0 parts found for '${query}' — try broader keywords, drop filters, or use search_passives for R/C values.`,
            { query, parts: [] }
          );
        }
        const top = parts[0];
        return ok(
          `${plural(parts.length, "part")} found for '${query}' — top: ${top.lcsc} (${top.tier}, ${formatStock(top.stock)} stock)`,
          { query, parts: parts.map(partBrief) }
        );
      } catch (e) {
        return err(`search_parts failed: ${errorMessage(e)}`);
      }
    }
  );
}
