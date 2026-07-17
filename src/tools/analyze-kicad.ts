import { z } from "zod";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { err, lineBrief, loadBomLinesFromFile, ok } from "./common.js";

export function registerAnalyzeKicad(server: McpServer): void {
  server.registerTool(
    "analyze_kicad",
    {
      title: "Analyze KiCad schematic / BOM",
      description:
        "Parse a KiCad schematic (.kicad_sch, KiCad 6-9) or a KiCad BOM CSV export (.csv) and return grouped BOM lines: references, quantity per board, value, JLC-style package derived from the footprint, component class, any pre-assigned LCSC part numbers, and DNP flags. Hierarchical sheets are followed automatically: sheet files referenced by the schematic are resolved relative to it, parsed recursively (each file once), and merged into the BOM; missing sheet files are skipped with a warning. Power symbols and #-references are excluded. Run this first to understand a design, then pass the same path to suggest_bom_parts for part suggestions.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Path to a .kicad_sch schematic or a BOM .csv export. Relative paths resolve against the MCP server's working directory."
          ),
      },
    },
    async ({ path: inputPath }) => {
      const loaded = await loadBomLinesFromFile(inputPath);
      if (!loaded.ok) return err(loaded.message);
      const { file, components, lines, warnings } = loaded;
      const preassigned = lines.filter((l) => l.lcsc).length;
      const dnp = lines.filter((l) => l.dnp).length;
      const extras = [
        preassigned > 0 ? `${preassigned} with LCSC pre-assigned` : null,
        dnp > 0 ? `${dnp} DNP` : null,
        // hierarchical-sheet info/warnings surfaced in the text output
        ...warnings,
      ].filter(Boolean);
      return ok(
        `${lines.length} BOM line${lines.length === 1 ? "" : "s"} (${components.length} components) from ${path.basename(file)}${extras.length ? ` — ${extras.join(", ")}` : ""}`,
        { file, componentCount: components.length, warnings, lines: lines.map(lineBrief) }
      );
    }
  );
}
