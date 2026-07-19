import { z } from "zod";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { err, errorMessage, ok } from "./common.js";

const MARKER = "__RESULT__";

/** Locate scripts/kicad_import.py whether running from dist/ or the bundled dist-plugin/. */
function driverPath(): string | null {
  const override = process.env.JLCPCB_KICAD_IMPORT_SCRIPT;
  if (override && existsSync(override)) return override;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "scripts", "kicad_import.py"), // bundled: dist-plugin/../scripts
    path.join(here, "..", "..", "scripts", "kicad_import.py"), // built: dist/tools/../../scripts
    path.join(here, "..", "..", "..", "scripts", "kicad_import.py"),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/**
 * import_part_to_kicad — turn an LCSC part number into a usable KiCad library
 * entry (symbol + footprint + 3D) by driving the kicad-lcsc-manager engine
 * headlessly, so a suggested part becomes usable in the design. The engine
 * fetches EasyEDA + JLCPCB data, converts, and registers the library in the
 * project's sym/fp-lib-table — the AI skill and the KiCad GUI plugin share one
 * import pipeline (same library layout and conventions).
 */
export function registerImportPart(server: McpServer): void {
  server.registerTool(
    "import_part_to_kicad",
    {
      title: "Import a part into a KiCad library",
      description:
        "Fetch an LCSC part's KiCad symbol, footprint, and 3D model (STEP + WRL) and add them to a KiCad project's libraries, registering them in the project's sym/fp-lib-table so the part is immediately usable. Reuses the kicad-lcsc-manager engine (github.com/hulryung/kicad-lcsc-manager) — install it or set KICAD_LCSC_MANAGER if missing. Requires python3. Run after picking parts with suggest_bom_parts / find_alternatives to make them usable in the schematic.",
      inputSchema: {
        lcsc: z
          .union([z.string(), z.array(z.string()).min(1)])
          .describe('LCSC part number(s), e.g. "C25804" or ["C25804","C7593"]'),
        project_dir: z
          .string()
          .describe(
            "KiCad project directory (or a .kicad_pro path). Library files are written under it (libs/lcsc/...) and registered in its lib tables.",
          ),
        include: z
          .array(z.enum(["symbol", "footprint", "model_3d"]))
          .optional()
          .describe("Which assets to import (default: all three)"),
        overwrite: z
          .boolean()
          .optional()
          .describe("Overwrite an existing entry for this LCSC id (default false)"),
        manager_path: z
          .string()
          .optional()
          .describe("Path to a kicad-lcsc-manager checkout, if not auto-detected"),
      },
    },
    async (input) => {
      try {
        const ids = (Array.isArray(input.lcsc) ? input.lcsc : [input.lcsc])
          .map((s) => s.trim())
          .filter(Boolean);
        if (ids.length === 0) return err("No LCSC part numbers provided.");

        const script = driverPath();
        if (!script) {
          return err(
            "Import driver (scripts/kicad_import.py) not found in the installed package. Set JLCPCB_KICAD_IMPORT_SCRIPT to its path.",
          );
        }

        try {
          execFileSync("python3", ["--version"], { stdio: "ignore" });
        } catch {
          return err("python3 is required for import_part_to_kicad but was not found on PATH.");
        }

        const args = [script, "--project", input.project_dir, "--lcsc", ...ids];
        const include = input.include ?? [];
        if (include.includes("symbol")) args.push("--symbol");
        if (include.includes("footprint")) args.push("--footprint");
        if (include.includes("model_3d")) args.push("--3d");
        if (input.overwrite) args.push("--overwrite");
        if (input.manager_path) args.push("--manager-path", input.manager_path);

        let stdout = "";
        try {
          stdout = execFileSync("python3", args, { encoding: "utf8", timeout: 180000 });
        } catch (e) {
          const eo = e as { stdout?: string; stderr?: string };
          stdout = eo.stdout ?? "";
          // The driver prints a __RESULT__ line even on handled errors; fall
          // through to parse it, else surface stderr.
          if (!stdout.includes(MARKER)) {
            return err(`import driver failed: ${(eo.stderr ?? errorMessage(e)).slice(0, 800)}`);
          }
        }

        const line = stdout
          .split("\n")
          .reverse()
          .find((l) => l.startsWith(MARKER));
        if (!line) return err(`import driver produced no result. Output: ${stdout.slice(0, 500)}`);
        const data = JSON.parse(line.slice(MARKER.length)) as {
          ok: boolean;
          error?: string;
          project?: string;
          library?: Record<string, unknown>;
          results?: Array<{ lcsc: string; success: boolean; error?: string; symbol?: unknown; footprint?: unknown; model_3d?: unknown }>;
        };

        if (!data.ok && data.error) return err(data.error);

        const results = data.results ?? [];
        const okCount = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success);
        const assets = (input.include && input.include.length > 0
          ? input.include
          : ["symbol", "footprint", "model_3d"]
        )
          .map((a) => (a === "model_3d" ? "3D" : a))
          .join(" + ");
        const summary =
          `Imported ${okCount}/${results.length} part(s) into ${input.project_dir} (${assets}), registered in the project libraries` +
          (failed.length ? ` — ${failed.length} failed: ${failed.map((f) => f.lcsc).join(", ")}` : "");

        return ok(summary, {
          project: data.project,
          library: data.library,
          results,
          nextSteps: [
            "Reopen the project in KiCad (or Preferences → Manage Libraries) — the imported symbols/footprints are ready to place.",
          ],
        });
      } catch (e) {
        return err(`import_part_to_kicad failed: ${errorMessage(e)}`);
      }
    },
  );
}
