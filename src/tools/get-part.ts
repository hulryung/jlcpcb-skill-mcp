import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { err, errorMessage, formatStock, formatUsd, ok, type ToolDeps } from "./common.js";

export function registerGetPart(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "get_part",
    {
      title: "Get JLCPCB part detail",
      description:
        'Look up a single part by LCSC number (e.g. "C25804") and return full detail: assembly tier (basic = no loading fee, preferred = $3 fee waived, extended = one-time $3 loading fee per unique part), live stock, quantity price breaks, parsed attributes (resistance, tolerance, voltage...), and product URL. Use to verify a candidate part before committing it to a BOM.',
      inputSchema: {
        lcsc: z.string().describe('LCSC part number, e.g. "C25804" (bare digits also accepted)'),
      },
    },
    async ({ lcsc }) => {
      try {
        const part = await deps.client.getPart(lcsc);
        if (!part) {
          return err(`Part "${lcsc}" not found on JLCPCB/LCSC — check the C-number or use search_parts.`);
        }
        const desc =
          part.description.length > 90 ? `${part.description.slice(0, 87)}...` : part.description;
        return ok(
          `${part.lcsc} — ${part.mfr} [${part.package}] (${part.tier}, ${formatStock(part.stock)} stock, ${formatUsd(part.unitPrice)} @ qty 1): ${desc}`,
          part
        );
      } catch (e) {
        return err(`get_part failed: ${errorMessage(e)}`);
      }
    }
  );
}
