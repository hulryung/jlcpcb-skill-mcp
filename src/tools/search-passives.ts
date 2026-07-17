import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ParsedValue } from "../types.js";
import { parseValue } from "../kicad/index.js";
import {
  clampLimit,
  err,
  errorMessage,
  formatFarads,
  formatOhms,
  formatStock,
  ok,
  partBrief,
  type ToolDeps,
} from "./common.js";

export function registerSearchPassives(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "search_passives",
    {
      title: "Parametric resistor/capacitor search",
      description:
        'Parametric JLCPCB search for chip resistors or capacitors by value. Parses the value string ("10k", "4k7", "0.1R", "100nF", "4u7", "10p") into ohms/farads and searches by exact spec, optionally filtered by package (0402/0603/0805...). Prefer this over search_parts for R/C BOM lines — it avoids fuzzy text matches. Results are ordered by the client; prefer basic-tier (no loading fee) parts with deep stock.',
      inputSchema: {
        kind: z.enum(["resistor", "capacitor"]).describe("Which passive family to search"),
        value: z
          .string()
          .describe(
            'Component value: resistors like "10k", "4k7", "0.1R", "1M", "470"; capacitors like "100nF", "4u7", "0.1uF", "10p"'
          ),
        package: z
          .string()
          .optional()
          .describe('Chip package filter, e.g. "0402", "0603", "0805", "1206"'),
        limit: z.number().int().optional().describe("Max results, clamped to 1-50 (default 10)"),
      },
    },
    async ({ kind, value, package: pkg, limit }) => {
      let parsed: ParsedValue;
      try {
        parsed = parseValue(value, kind);
      } catch (e) {
        return err(`Could not parse "${value}": ${errorMessage(e)}`);
      }
      const cappedLimit = clampLimit(limit, 10);
      try {
        if (kind === "resistor") {
          if (parsed.kind !== "resistance") {
            return err(
              `Could not parse "${value}" as a resistance — use formats like "10k", "4k7", "0.1R", "1M", "470", or use search_parts for free-text search.`
            );
          }
          const parts = await deps.client.searchResistors({
            ohms: parsed.ohms,
            package: pkg,
            limit: cappedLimit,
          });
          return passivesResult(kind, value, formatOhms(parsed.ohms), pkg, parsed, parts);
        }
        if (parsed.kind !== "capacitance") {
          return err(
            `Could not parse "${value}" as a capacitance — use formats like "100nF", "4u7", "0.1uF", "10p", or use search_parts for free-text search.`
          );
        }
        const parts = await deps.client.searchCapacitors({
          farads: parsed.farads,
          package: pkg,
          limit: cappedLimit,
        });
        return passivesResult(kind, value, formatFarads(parsed.farads), pkg, parsed, parts);
      } catch (e) {
        return err(`search_passives failed: ${errorMessage(e)}`);
      }
    }
  );
}

function passivesResult(
  kind: "resistor" | "capacitor",
  value: string,
  normalized: string,
  pkg: string | undefined,
  parsed: ParsedValue,
  parts: import("../types.js").Part[]
) {
  const where = `'${value}' (${normalized}${pkg ? `, ${pkg}` : ""})`;
  if (parts.length === 0) {
    return ok(
      `0 ${kind}s found for ${where} — try dropping the package filter or a nearby E-series value.`,
      { kind, value, parsed, parts: [] }
    );
  }
  const top = parts[0];
  return ok(
    `${parts.length} ${kind}${parts.length === 1 ? "" : "s"} found for ${where} — top: ${top.lcsc} (${top.tier}, ${formatStock(top.stock)} stock)`,
    { kind, value, parsed, parts: parts.map(partBrief) }
  );
}
