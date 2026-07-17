import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BomLine, ComponentClass, ParsedValue, Part } from "../types.js";
import { DEFAULT_SUGGEST_OPTIONS, rankCandidates } from "../engine/index.js";
import { STRICT_PACKAGE_CLASSES } from "../engine/rank.js";
import { parseValue } from "../kicad/index.js";
import {
  candidateBrief,
  clampLimit,
  err,
  errorMessage,
  formatStock,
  ok,
  partBrief,
  plural,
  type ToolDeps,
} from "./common.js";

export function registerFindAlternatives(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "find_alternatives",
    {
      title: "Find alternative parts",
      description:
        "Given an LCSC part number, find ranked drop-in alternatives with matching specs and package — useful when a part is out of stock, extended-tier (carries the $3 loading fee), or expensive. The original part is excluded from results. Ranking prefers basic/preferred tier (no loading fee), deep stock relative to need, and lower price; each alternative carries reasons and warnings.",
      inputSchema: {
        lcsc: z.string().describe('LCSC part number of the part to replace, e.g. "C25804"'),
        limit: z
          .number()
          .int()
          .optional()
          .describe("Max alternatives to return, clamped to 1-50 (default 5)"),
      },
    },
    async ({ lcsc, limit }) => {
      try {
        const target = await deps.client.getPart(lcsc);
        if (!target) {
          return err(`Part "${lcsc}" not found on JLCPCB/LCSC — cannot search alternatives.`);
        }
        const cls = classifyPart(target);

        // getPart never populates Part.attributes, so for passives fetch the
        // spec-bearing Part from the parametric category endpoint; fall back
        // to probing the target's own attributes when unavailable or null.
        let specSource: Part = target;
        if (cls === "resistor" || cls === "capacitor") {
          try {
            const detail = await deps.client.getPassiveDetail(lcsc, cls);
            if (detail) specSource = detail;
          } catch {
            // detail lookup failed — keep the getPart result as spec source
          }
        }
        const parsed = parsedSpec(specSource, cls);
        const line: BomLine = {
          references: [target.lcsc],
          qtyPerBoard: 1,
          value: specValue(specSource, cls) ?? target.mfr,
          package: target.package || specSource.package || undefined,
          componentClass: cls,
          parsed,
          dnp: false,
        };

        let pool: Part[];
        if (cls === "resistor" && parsed?.kind === "resistance") {
          pool = await deps.client.searchResistors({
            ohms: parsed.ohms,
            package: line.package,
            limit: 50,
          });
        } else if (cls === "capacitor" && parsed?.kind === "capacitance") {
          pool = await deps.client.searchCapacitors({
            farads: parsed.farads,
            package: line.package,
            limit: 50,
          });
        } else {
          pool = await deps.client.searchComponents({
            q: target.mfr || target.description,
            // Mirror engine/suggest.ts: only chip-passive classes get the
            // client's exact package filter. Other classes rely on
            // rankCandidates' prefix-tolerant matcher, so package variants
            // ("SOIC-8" vs "SOIC-8-EP") are kept and flagged, not pre-dropped.
            package: STRICT_PACKAGE_CLASSES.has(cls) ? line.package : undefined,
            limit: 50,
          });
        }

        const maxCandidates = clampLimit(limit, 5);
        const others = pool.filter((p) => p.lcscId !== target.lcscId);
        const candidates = rankCandidates(line, others, {
          ...DEFAULT_SUGGEST_OPTIONS,
          maxCandidates,
        }).slice(0, maxCandidates);

        if (candidates.length === 0) {
          return ok(
            `0 alternatives found for ${target.lcsc} (${target.mfr}) — try search_parts with broader terms or a different package.`,
            { target: partBrief(target), alternatives: [] }
          );
        }
        const top = candidates[0];
        return ok(
          `${plural(candidates.length, "alternative")} found for ${target.lcsc} (${target.mfr}) — top: ${top.part.lcsc} (${top.part.tier}, ${formatStock(top.part.stock)} stock)`,
          { target: partBrief(target), alternatives: candidates.map(candidateBrief) }
        );
      } catch (e) {
        return err(`find_alternatives failed: ${errorMessage(e)}`);
      }
    }
  );
}

/** Best-effort class from catalog category/description (Parts carry no ComponentClass). */
function classifyPart(p: Part): ComponentClass {
  const hay = `${p.category ?? ""} ${p.subcategory ?? ""} ${p.description}`.toLowerCase();
  if (/resistor/.test(hay)) return "resistor";
  if (/capacitor/.test(hay)) return "capacitor";
  if (/inductor/.test(hay)) return "inductor";
  if (/ferrite/.test(hay)) return "ferrite_bead";
  if (/\bled\b|light[- ]emitting/.test(hay)) return "led";
  if (/diode|rectifier/.test(hay)) return "diode";
  if (/transistor|mosfet|\bbjt\b/.test(hay)) return "transistor";
  if (/crystal|oscillator|resonator/.test(hay)) return "crystal";
  if (/connector|socket|header|receptacle/.test(hay)) return "connector";
  if (/switch|button/.test(hay)) return "switch";
  if (/fuse/.test(hay)) return "fuse";
  if (/regulator|microcontroller|amplifier|converter|driver|sensor|memory|logic|\bmcu\b|\bic\b/.test(hay)) {
    return "ic";
  }
  return "other";
}

function specValue(p: Part, cls: ComponentClass): string | undefined {
  const attrs = p.attributes ?? {};
  if (cls === "resistor") return attrs["Resistance"];
  if (cls === "capacitor") return attrs["Capacitance"];
  return undefined;
}

function parsedSpec(p: Part, cls: ComponentClass): ParsedValue | undefined {
  const raw = specValue(p, cls);
  if (!raw || (cls !== "resistor" && cls !== "capacitor")) return undefined;
  try {
    const parsed = parseValue(raw, cls);
    return parsed.kind === "resistance" || parsed.kind === "capacitance" ? parsed : undefined;
  } catch {
    return undefined;
  }
}
