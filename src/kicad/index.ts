/** Public surface of the KiCad analysis module. */

import type { BomLine } from "../types.js";
import { parseBomCsv, groupBom } from "./bom.js";
import { parseSchematic } from "./schematic.js";

export { parseSExpr } from "./sexpr.js";
export type { SExpr } from "./sexpr.js";
export { parseSchematic, listSheetFiles } from "./schematic.js";
export { parseBomCsv, groupBom } from "./bom.js";
export { classifyComponent, parseValue, packageFromFootprint } from "./value.js";

/** Dispatch on file extension: .kicad_sch → schematic parser, .csv → BOM parser. */
export function analyzeKicadFile(text: string, filename: string): BomLine[] {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".kicad_sch")) return groupBom(parseSchematic(text));
  if (lower.endsWith(".csv")) return groupBom(parseBomCsv(text));
  throw new Error(
    `Unsupported file type: ${filename} — expected a .kicad_sch schematic or a .csv BOM export`,
  );
}
