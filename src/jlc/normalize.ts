/**
 * Normalization of raw jlcsearch API rows into the shared Part type.
 * Raw shapes are documented in docs/jlcsearch-api-notes.md.
 */
import type { Part, PartTier, PriceBreak } from "../types.js";

/** "C25804" | "25804" | 25804 → 25804. Throws a descriptive Error on garbage. */
export function toLcscId(lcsc: string | number): number {
  if (typeof lcsc === "number") {
    if (Number.isInteger(lcsc) && lcsc > 0) return lcsc;
    throw new Error(`Invalid LCSC number: ${lcsc} (expected a positive integer)`);
  }
  const trimmed = lcsc.trim();
  const m = /^[Cc]?(\d+)$/.exec(trimmed);
  if (!m) {
    throw new Error(`Invalid LCSC number: ${JSON.stringify(lcsc)} (expected "C123..." or digits)`);
  }
  const id = Number.parseInt(m[1], 10);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Invalid LCSC number: ${JSON.stringify(lcsc)} (expected a positive integer)`);
  }
  return id;
}

/**
 * Price sources vary by endpoint: a single number (price/price1), a JSON string
 * of [{qFrom,qTo,price}] (/components/list.json), or an already-parsed array.
 * Returns breaks sorted ascending by qFrom; [] when unparseable.
 */
export function parsePriceBreaks(price: unknown): PriceBreak[] {
  if (price == null) return [];
  if (typeof price === "number") {
    return Number.isFinite(price) && price >= 0 ? [{ qFrom: 1, qTo: null, price }] : [];
  }
  if (typeof price === "string") {
    const text = price.trim();
    if (text === "") return [];
    const asNumber = Number(text);
    if (Number.isFinite(asNumber)) return parsePriceBreaks(asNumber);
    try {
      return parsePriceBreaks(JSON.parse(text));
    } catch {
      return [];
    }
  }
  if (Array.isArray(price)) {
    const breaks: PriceBreak[] = [];
    for (const row of price) {
      if (typeof row !== "object" || row === null) continue;
      const r = row as Record<string, unknown>;
      const p = typeof r.price === "number" ? r.price : Number(r.price);
      if (!Number.isFinite(p) || p < 0) continue;
      const qFromRaw = typeof r.qFrom === "number" ? r.qFrom : Number(r.qFrom ?? 1);
      const qFrom = Number.isFinite(qFromRaw) && qFromRaw >= 1 ? qFromRaw : 1;
      const qTo = typeof r.qTo === "number" && Number.isFinite(r.qTo) ? r.qTo : null;
      breaks.push({ qFrom, qTo, price: p });
    }
    breaks.sort((a, b) => a.qFrom - b.qFrom);
    return breaks;
  }
  return [];
}

function asRecord(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Cannot normalize ${what}: expected an object, got ${typeof raw}`);
  }
  return raw as Record<string, unknown>;
}

function parseAttributes(raw: unknown): Record<string, string> | undefined {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") return undefined;
    try {
      obj = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v == null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function tierOf(r: Record<string, unknown>): PartTier {
  if (r.is_basic === true) return "basic";
  if (r.is_preferred === true) return "preferred";
  return "extended";
}

function toStock(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function optString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function basePart(r: Record<string, unknown>): Part {
  if (typeof r.lcsc !== "number" && typeof r.lcsc !== "string") {
    throw new Error(`Cannot normalize part row: missing lcsc field (got ${JSON.stringify(r.lcsc)})`);
  }
  const lcscId = toLcscId(r.lcsc);
  // /api/search uses `price` (single number); category endpoints use `price1`;
  // /components/list.json uses `price` (JSON string of breaks).
  const priceBreaks = parsePriceBreaks(r.price ?? r.price1);
  const attributes = parseAttributes(r.attributes);
  const part: Part = {
    lcsc: `C${lcscId}`,
    lcscId,
    mfr: typeof r.mfr === "string" ? r.mfr : "",
    description: typeof r.description === "string" ? r.description : "",
    package: typeof r.package === "string" ? r.package : "",
    stock: toStock(r.stock),
    tier: tierOf(r),
    priceBreaks,
    unitPrice: priceBreaks.length > 0 ? priceBreaks[0].price : null,
    productUrl: `https://jlcpcb.com/partdetail/C${lcscId}`,
  };
  const category = optString(r.category);
  const subcategory = optString(r.subcategory);
  if (category !== undefined) part.category = category;
  if (subcategory !== undefined) part.subcategory = subcategory;
  if (attributes !== undefined) part.attributes = attributes;
  return part;
}

/** Attribute keys worth surfacing in a synthesized description, in order. */
const DESCRIPTION_ATTR_KEYS = [
  "Resistance",
  "Capacitance",
  "Tolerance",
  "Voltage Rated",
  "Temperature Coefficient",
  "Power(Watts)",
];

// Category endpoints return description: "" — synthesize one from attributes so
// downstream consumers always have display text.
function withSynthesizedDescription(part: Part): Part {
  if (part.description !== "" || part.attributes === undefined) return part;
  const bits = DESCRIPTION_ATTR_KEYS.map((k) => part.attributes![k]).filter(
    (v): v is string => typeof v === "string" && v !== "" && v !== "-",
  );
  if (part.package !== "") bits.push(part.package);
  return bits.length > 0 ? { ...part, description: bits.join(" ") } : part;
}

/** Normalize a row from /api/search or /components/list.json. */
export function normalizeComponent(raw: unknown): Part {
  return basePart(asRecord(raw, "component"));
}

/** Normalize a row from /resistors/list.json. */
export function normalizeResistor(raw: unknown): Part {
  return withSynthesizedDescription(basePart(asRecord(raw, "resistor")));
}

/** Normalize a row from /capacitors/list.json. */
export function normalizeCapacitor(raw: unknown): Part {
  return withSynthesizedDescription(basePart(asRecord(raw, "capacitor")));
}
