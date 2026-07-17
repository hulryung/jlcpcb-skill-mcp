/**
 * Extract placed symbol instances from .kicad_sch text (KiCad 6/7/8/9).
 * Only top-level (symbol ...) children of (kicad_sch ...) are instances;
 * (symbol ...) nodes inside (lib_symbols ...) are library definitions.
 */

import { parseSExpr, type SExpr } from "./sexpr.js";
import type { KicadComponent } from "../types.js";

const isList = (e: SExpr | undefined): e is SExpr[] => Array.isArray(e);

function childList(list: SExpr[], head: string): SExpr[] | undefined {
  return list.find((e): e is SExpr[] => isList(e) && e[0] === head);
}

function childLists(list: SExpr[], head: string): SExpr[][] {
  return list.filter((e): e is SExpr[] => isList(e) && e[0] === head);
}

function atomAt(list: SExpr[] | undefined, i: number): string | undefined {
  const v = list?.[i];
  return typeof v === "string" ? v : undefined;
}

function normalizeFieldName(name: string): string {
  // NFKC folds full-width characters (ＬＣＳＣ, （…）) to their ASCII forms
  // before everything non-alphanumeric is stripped.
  return name.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Does a property/header name carry an LCSC part number? Matched after
 * normalization so JLCPCB's own template header "LCSC Part #（optional）"
 * (full-width parens) is recognized. Prefix matching is deliberate for
 * "lcsc…"/"jlcpcb…", but bare "jlc" only matches exact part-number spellings
 * so unrelated columns like "JLC Rotation" are not mistaken for LCSC fields.
 */
export function isLcscFieldName(name: string): boolean {
  const n = normalizeFieldName(name);
  if (n.startsWith("lcsc") || n.startsWith("jlcpcb")) return true;
  return n === "jlc" || n === "jlcpart" || n === "jlcpartnumber";
}

function extractLcsc(properties: Record<string, string>): string | undefined {
  for (const [name, value] of Object.entries(properties)) {
    if (!isLcscFieldName(name)) continue;
    // value guard: only a plausible LCSC number ("C25804" or bare digits) counts
    const m = value.trim().match(/^c?(\d+)$/i);
    if (m) return `C${m[1]}`;
  }
  return undefined;
}

function isDnpPropertyValue(v: string): boolean {
  // Same semantics as the BOM-CSV DNP column: an empty/whitespace value is
  // NOT DNP (KiCad leaves the field blank on populated parts), explicit
  // negatives ("no"/"false"/"0") are not DNP, any other value ("DNP", "yes",
  // "x", …) marks the part do-not-populate.
  const t = v.trim().toLowerCase();
  return t !== "" && !["no", "false", "0"].includes(t);
}

function readSymbolInstance(node: SExpr[]): KicadComponent | null {
  const libId = atomAt(childList(node, "lib_id"), 1) ?? "";

  const properties: Record<string, string> = {};
  for (const prop of childLists(node, "property")) {
    const name = typeof prop[1] === "string" ? prop[1] : undefined;
    const value = typeof prop[2] === "string" ? prop[2] : "";
    if (name !== undefined) properties[name] = value;
  }

  const reference = properties["Reference"] ?? "";
  if (!reference || reference.startsWith("#")) return null; // #PWR, #FLG…
  if (libId.toLowerCase().startsWith("power:")) return null;
  if (atomAt(childList(node, "in_bom"), 1) === "no") return null;

  let dnp = atomAt(childList(node, "dnp"), 1) === "yes";
  for (const [name, value] of Object.entries(properties)) {
    if (name.trim().toLowerCase() === "dnp" && isDnpPropertyValue(value)) dnp = true;
  }

  const footprint = properties["Footprint"]?.trim();
  const lcsc = extractLcsc(properties);

  const comp: KicadComponent = {
    reference,
    value: properties["Value"] ?? "",
    dnp,
    properties,
  };
  if (footprint) comp.footprint = footprint;
  if (lcsc) comp.lcsc = lcsc;
  return comp;
}

function schematicRoot(text: string): SExpr[] {
  const doc = parseSExpr(text);
  const root = doc.find((e): e is SExpr[] => isList(e) && e[0] === "kicad_sch");
  if (!root) {
    throw new Error("Not a KiCad schematic: missing (kicad_sch ...) root element");
  }
  return root;
}

/** Extract placed symbols from .kicad_sch text. Multi-unit parts collapse to one entry. */
export function parseSchematic(text: string): KicadComponent[] {
  const root = schematicRoot(text);

  const byRef = new Map<string, KicadComponent>();
  for (const node of root) {
    if (!isList(node) || node[0] !== "symbol") continue;
    const comp = readSymbolInstance(node);
    if (!comp) continue;
    const existing = byRef.get(comp.reference);
    if (existing) {
      // additional unit of a multi-unit part: merge anything the first unit lacked
      existing.dnp = existing.dnp || comp.dnp;
      if (!existing.footprint && comp.footprint) existing.footprint = comp.footprint;
      if (!existing.lcsc && comp.lcsc) existing.lcsc = comp.lcsc;
      for (const [k, v] of Object.entries(comp.properties)) {
        if (!(k in existing.properties)) existing.properties[k] = v;
      }
    } else {
      byRef.set(comp.reference, comp);
    }
  }
  return [...byRef.values()];
}

/**
 * List the sub-schematic files referenced by hierarchical sheets: the
 * "Sheetfile" (KiCad 7+) or "Sheet file" (KiCad 6) property of every
 * top-level (sheet ...) child of kicad_sch. Deduped, in document order.
 */
export function listSheetFiles(text: string): string[] {
  const root = schematicRoot(text);
  const files: string[] = [];
  const seen = new Set<string>();
  for (const node of root) {
    if (!isList(node) || node[0] !== "sheet") continue;
    for (const prop of childLists(node, "property")) {
      const name = typeof prop[1] === "string" ? prop[1] : undefined;
      const value = typeof prop[2] === "string" ? prop[2] : undefined;
      if (name === undefined || value === undefined) continue;
      const n = name.trim().toLowerCase();
      if (n !== "sheetfile" && n !== "sheet file") continue;
      const v = value.trim();
      if (v && !seen.has(v)) {
        seen.add(v);
        files.push(v);
      }
      break; // one Sheetfile per sheet
    }
  }
  return files;
}
