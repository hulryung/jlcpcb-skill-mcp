/**
 * KiCad BOM CSV parsing (flexible headers, quoted fields, grouped references)
 * and grouping of components into BOM lines.
 */

import type { BomLine, KicadComponent, ParsedValue } from "../types.js";
import { isLcscFieldName } from "./schematic.js";
import { classifyComponent, packageFromFootprint, parseValue } from "./value.js";

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function sniffDelimiter(text: string): string {
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  if (!firstLine.includes(",")) {
    if (firstLine.includes(";")) return ";";
    if (firstLine.includes("\t")) return "\t";
  }
  return ",";
}

/** RFC-4180-style parse: quoted fields may contain delimiters, "" escapes, newlines. */
function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // strip BOM

  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

// ---------------------------------------------------------------------------
// Header mapping
// ---------------------------------------------------------------------------

function normalizeHeader(name: string): string {
  // NFKC folds full-width characters (（…）) to ASCII before stripping
  return name.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const REF_HEADERS = new Set(["reference", "references", "designator", "designators", "ref", "refs", "refdes"]);
const VALUE_HEADERS = new Set(["value", "values", "val"]);
const VALUE_FALLBACK_HEADERS = new Set(["comment", "comments"]);
const FOOTPRINT_HEADERS = new Set(["footprint", "footprints", "package"]);
const DNP_HEADERS = new Set(["dnp"]);

function findColumn(header: string[], names: Set<string>): number | undefined {
  for (let i = 0; i < header.length; i++) {
    if (names.has(normalizeHeader(header[i]!))) return i;
  }
  return undefined;
}

/** LCSC column: shares the schematic property-name rule ("LCSC Part #（optional）" etc.). */
function findLcscColumn(header: string[]): number | undefined {
  for (let i = 0; i < header.length; i++) {
    if (isLcscFieldName(header[i]!)) return i;
  }
  return undefined;
}

function normalizeLcscValue(v: string): string | undefined {
  const m = v.trim().match(/^c?(\d+)$/i);
  return m ? `C${m[1]}` : undefined;
}

/** Parse a KiCad BOM CSV export. One KicadComponent per individual reference. */
export function parseBomCsv(text: string): KicadComponent[] {
  const rows = parseCsv(text, sniffDelimiter(text));
  if (rows.length === 0) throw new Error("BOM CSV is empty");

  const header = rows[0]!.map((h) => h.trim());
  const refIdx = findColumn(header, REF_HEADERS);
  if (refIdx === undefined) {
    throw new Error(
      `BOM CSV: no reference column found (expected one of Reference/References/Designator); got header: ${header.join(", ")}`,
    );
  }
  const valueIdx = findColumn(header, VALUE_HEADERS) ?? findColumn(header, VALUE_FALLBACK_HEADERS);
  const fpIdx = findColumn(header, FOOTPRINT_HEADERS);
  const lcscIdx = findLcscColumn(header);
  const dnpIdx = findColumn(header, DNP_HEADERS);

  const out: KicadComponent[] = [];
  for (const row of rows.slice(1)) {
    const cell = (idx: number | undefined): string =>
      idx === undefined ? "" : (row[idx] ?? "").trim();

    const refsCell = cell(refIdx);
    if (!refsCell) continue;
    const refs = refsCell.split(/[,;\s]+/).filter(Boolean);

    const value = cell(valueIdx);
    const footprint = cell(fpIdx);
    const lcsc = normalizeLcscValue(cell(lcscIdx));
    const dnpCell = cell(dnpIdx);
    const dnp = dnpCell !== "" && !["no", "false", "0"].includes(dnpCell.toLowerCase());

    const properties: Record<string, string> = {};
    header.forEach((h, i) => {
      if (h) properties[h] = (row[i] ?? "").trim();
    });

    for (const reference of refs) {
      if (reference.startsWith("#")) continue;
      const comp: KicadComponent = {
        reference,
        value,
        dnp,
        properties: { ...properties },
      };
      if (footprint) comp.footprint = footprint;
      if (lcsc) comp.lcsc = lcsc;
      out.push(comp);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/** Round so equivalent spellings ("100n" vs "0.1u") land on the same key. */
function canonicalNumber(x: number): string {
  return Number(x.toPrecision(6)).toString();
}

function canonicalValueKey(parsed: ParsedValue, valueText: string): string {
  switch (parsed.kind) {
    case "resistance": {
      const tol = parsed.tolerancePct !== undefined ? `:tol${parsed.tolerancePct}` : "";
      return `res:${canonicalNumber(parsed.ohms)}${tol}`;
    }
    case "capacitance": {
      const v = parsed.voltage !== undefined ? `:v${parsed.voltage}` : "";
      const d = parsed.dielectric !== undefined ? `:${parsed.dielectric}` : "";
      return `cap:${canonicalNumber(parsed.farads)}${v}${d}`;
    }
    case "inductance":
      return `ind:${canonicalNumber(parsed.henries)}`;
    case "frequency":
      return `freq:${canonicalNumber(parsed.hertz)}`;
    case "raw":
      return `raw:${valueText.trim().toLowerCase()}`;
  }
}

function naturalRefCompare(a: string, b: string): number {
  const ma = a.match(/^([A-Za-z]*)(\d*)/)!;
  const mb = b.match(/^([A-Za-z]*)(\d*)/)!;
  if (ma[1] !== mb[1]) return ma[1]! < mb[1]! ? -1 : 1;
  const na = ma[2] ? parseInt(ma[2]!, 10) : -1;
  const nb = mb[2] ? parseInt(mb[2]!, 10) : -1;
  if (na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Group components into BOM lines by (class, normalized value, package, lcsc).
 * DNP components form separate lines (dnp: true) so they are never conflated
 * with populated lines of the same value.
 */
export function groupBom(components: KicadComponent[]): BomLine[] {
  const groups = new Map<string, BomLine>();

  for (const c of components) {
    const componentClass = classifyComponent(c);
    const parsed = parseValue(c.value, componentClass);
    const pkg = packageFromFootprint(c.footprint);
    const key = [
      componentClass,
      canonicalValueKey(parsed, c.value),
      pkg ?? c.footprint ?? "",
      c.lcsc ?? "",
      c.dnp ? "dnp" : "",
    ].join("|");

    const existing = groups.get(key);
    if (existing) {
      if (!existing.references.includes(c.reference)) {
        existing.references.push(c.reference);
        existing.qtyPerBoard = existing.references.length;
      }
      if (!existing.footprint && c.footprint) existing.footprint = c.footprint;
    } else {
      const line: BomLine = {
        references: [c.reference],
        qtyPerBoard: 1,
        value: c.value.trim(),
        componentClass,
        parsed,
        dnp: c.dnp,
      };
      if (c.footprint) line.footprint = c.footprint;
      if (pkg) line.package = pkg;
      if (c.lcsc) line.lcsc = c.lcsc;
      groups.set(key, line);
    }
  }

  const lines = [...groups.values()];
  for (const line of lines) line.references.sort(naturalRefCompare);
  return lines;
}
