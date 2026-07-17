/**
 * Ranking: hard filters + scoring of candidate Parts against a BomLine.
 * Pure logic — imports only from ../types.js.
 */
import type { BomLine, Candidate, Part, PriceBreak, SuggestOptions } from "../types.js";

// Scoring weights (referenced by tests/reviewers — keep named).
export const WEIGHT_TIER_BASIC = 100;
export const WEIGHT_TIER_PREFERRED = 60;
export const WEIGHT_TIER_EXTENDED = 0;
export const WEIGHT_STOCK_ADEQUACY_MAX = 25;
export const WEIGHT_STOCK_DEPTH_MAX = 10;
export const WEIGHT_PRICE_MAX = 15;
export const WEIGHT_TOLERANCE_BONUS = 3;

// Float-safe relative tolerances for spec equality.
export const RESISTANCE_REL_TOL = 0.005;
export const CAPACITANCE_REL_TOL = 0.05;

/**
 * Walk sorted priceBreaks to the break containing qty (qFrom <= qty <= qTo|∞).
 * qty above all breaks → last break; qty below the first break → first break;
 * empty breaks → part.unitPrice.
 */
export function unitPriceAtQty(part: Part, qty: number): number | null {
  const breaks = part.priceBreaks;
  if (!breaks || breaks.length === 0) return part.unitPrice;
  const sorted = [...breaks].sort((a, b) => a.qFrom - b.qFrom);
  let best: PriceBreak | null = null;
  for (const b of sorted) {
    if (b.qFrom <= qty) {
      best = b;
      if (b.qTo === null || qty <= b.qTo) return b.price;
    }
  }
  return (best ?? sorted[0]).price;
}

// ---------------------------------------------------------------------------
// Spec parsing helpers (private) — engine cannot import Module B's parser.
// ---------------------------------------------------------------------------

// m/M distinction (milli vs mega) requires case-sensitive multipliers.
const RES_MULT: Record<string, number> = {
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  "µ": 1e-6, // micro sign
  "μ": 1e-6, // greek mu
  m: 1e-3,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
};

// Capacitors never use pico/nano ambiguously — case-insensitive except milli.
const CAP_MULT: Record<string, number> = {
  p: 1e-12,
  P: 1e-12,
  n: 1e-9,
  N: 1e-9,
  u: 1e-6,
  U: 1e-6,
  "µ": 1e-6,
  "μ": 1e-6,
  m: 1e-3,
};

// Ω greek omega, Ω ohm sign.
const OHM_UNIT_RE = /(?:Ω|Ω|ohms?)\s*$/i;
const RES_DESC_RE = /(\d+(?:\.\d+)?)\s*([pnuµμmkKMG])?\s*(?:Ω|Ω|[Oo][Hh][Mm][Ss]?\b)/;
const CAP_DESC_RE = /(\d+(?:\.\d+)?)\s*([pPnNuUµμm])F(?![A-Za-z])/;
const TOL_RE = /±\s*(\d+(?:\.\d+)?)\s*%/;

function parseResistanceText(text: string): number | undefined {
  let t = text.trim().replace(OHM_UNIT_RE, "").trim();
  t = t.replace(/R$/i, "").trim();
  const m = /^(\d+(?:\.\d+)?)\s*([pnuµμmkKMG])?$/.exec(t);
  if (!m) return undefined;
  const mult = m[2] ? RES_MULT[m[2]] : 1;
  return Number(m[1]) * mult;
}

function parseCapacitanceText(text: string): number | undefined {
  const t = text.trim().replace(/F(?:arads?)?\s*$/i, "").trim();
  const m = /^(\d+(?:\.\d+)?)\s*([pPnNuUµμm])?$/.exec(t);
  if (!m) return undefined;
  const mult = m[2] ? CAP_MULT[m[2]] : 1;
  return Number(m[1]) * mult;
}

function attrValue(part: Part, keyRe: RegExp): string | undefined {
  if (!part.attributes) return undefined;
  for (const [key, value] of Object.entries(part.attributes)) {
    if (keyRe.test(key)) return value;
  }
  return undefined;
}

function partResistance(part: Part): number | undefined {
  const attr = attrValue(part, /resistance/i);
  if (attr !== undefined) {
    const parsed = parseResistanceText(attr);
    if (parsed !== undefined) return parsed;
  }
  const m = RES_DESC_RE.exec(part.description);
  if (!m) return undefined;
  const mult = m[2] ? RES_MULT[m[2]] : 1;
  return Number(m[1]) * mult;
}

function partCapacitance(part: Part): number | undefined {
  const attr = attrValue(part, /capacitance/i);
  if (attr !== undefined) {
    const parsed = parseCapacitanceText(attr);
    if (parsed !== undefined) return parsed;
  }
  const m = CAP_DESC_RE.exec(part.description);
  if (!m) return undefined;
  const mult = m[2] ? CAP_MULT[m[2]] : 1;
  return Number(m[1]) * mult;
}

function partTolerancePct(part: Part): number | undefined {
  const attr = attrValue(part, /tolerance/i);
  if (attr !== undefined) {
    const m = /±?\s*(\d+(?:\.\d+)?)\s*%/.exec(attr);
    if (m) return Number(m[1]);
  }
  const m = TOL_RE.exec(part.description);
  return m ? Number(m[1]) : undefined;
}

function relEqual(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b)) + Number.EPSILON;
}

// "R0603"/"C0805"/"L0402" are imperial-size aliases — strip the class prefix.
function normalizePackage(pkg: string): string {
  const p = pkg.trim().toUpperCase();
  const m = /^[RCL](\d{4,5})$/.exec(p);
  return m ? m[1] : p;
}

/** Chip-size packages must match exactly; anything else risks a wrong reel. */
export const STRICT_PACKAGE_CLASSES: ReadonlySet<string> = new Set([
  "resistor",
  "capacitor",
  "inductor",
  "ferrite_bead",
]);

type PackageMatch = "exact" | "prefix" | "mismatch";

/**
 * IC/connector footprint names vary between KiCad and JLC ("QFN-32" vs
 * "QFN-32-EP(5x5)"), so non-passive classes accept a prefix match at a
 * non-alphanumeric boundary — callers must surface it as a verify-warning,
 * since the suffix can also be load-bearing (SOT-23 vs SOT-23-5).
 */
function comparePackages(linePkg: string, partPkg: string, cls: BomLine["componentClass"]): PackageMatch {
  const a = normalizePackage(linePkg);
  const b = normalizePackage(partPkg);
  if (a === b) return "exact";
  if (STRICT_PACKAGE_CLASSES.has(cls)) return "mismatch";
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!long.startsWith(short)) return "mismatch";
  const boundary = long[short.length];
  return boundary !== undefined && !/[0-9A-Z]/.test(boundary) ? "prefix" : "mismatch";
}

// ---------------------------------------------------------------------------
// Hard filters
// ---------------------------------------------------------------------------

interface FilterResult {
  dropReasons: string[];
  warnings: string[];
}

function applyHardFilters(line: BomLine, part: Part): FilterResult {
  const dropReasons: string[] = [];
  const warnings: string[] = [];

  if (part.stock <= 0) dropReasons.push("out of stock");

  if (line.package) {
    if (!part.package || part.package.trim() === "") {
      warnings.push("package unverified — part package unknown");
    } else {
      const match = comparePackages(line.package, part.package, line.componentClass);
      if (match === "mismatch") {
        dropReasons.push(`package mismatch: part is ${part.package}, line wants ${line.package}`);
      } else if (match === "prefix") {
        warnings.push(
          `package prefix match only: part is ${part.package}, line wants ${line.package} — verify footprint`,
        );
      }
    }
  }

  const parsed = line.parsed;
  if (parsed?.kind === "resistance") {
    const ohms = partResistance(part);
    if (ohms === undefined) {
      warnings.push("value unverified — could not read resistance from part data");
    } else if (!relEqual(ohms, parsed.ohms, RESISTANCE_REL_TOL)) {
      dropReasons.push(`resistance mismatch: part is ${ohms}Ω, line wants ${parsed.ohms}Ω`);
    }
    if (parsed.tolerancePct !== undefined) {
      const tol = partTolerancePct(part);
      if (tol === undefined) {
        warnings.push("tolerance unverified");
      } else if (tol > parsed.tolerancePct * (1 + 1e-9)) {
        dropReasons.push(`tolerance too loose: ±${tol}% > required ±${parsed.tolerancePct}%`);
      }
    }
  } else if (parsed?.kind === "capacitance") {
    const farads = partCapacitance(part);
    if (farads === undefined) {
      warnings.push("value unverified — could not read capacitance from part data");
    } else if (!relEqual(farads, parsed.farads, CAPACITANCE_REL_TOL)) {
      dropReasons.push(`capacitance mismatch: part is ${farads}F, line wants ${parsed.farads}F`);
    }
  }

  return { dropReasons, warnings };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function tierWeight(tier: Part["tier"]): number {
  switch (tier) {
    case "basic":
      return WEIGHT_TIER_BASIC;
    case "preferred":
      return WEIGHT_TIER_PREFERRED;
    default:
      return WEIGHT_TIER_EXTENDED;
  }
}

function tierReason(tier: Part["tier"]): string {
  switch (tier) {
    case "basic":
      return "Basic part — no loading fee";
    case "preferred":
      return "Preferred extended — loading fee waived";
    default:
      return "Extended part — $3 loading fee applies";
  }
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

function trimNum(n: number): string {
  return String(Math.round(n * 10) / 10);
}

function formatStock(stock: number): string {
  if (stock >= 1e6) return `${trimNum(stock / 1e6)}M`;
  if (stock >= 1e3) return `${trimNum(stock / 1e3)}k`;
  return String(stock);
}

function fmtUsd(p: number): string {
  return p >= 1 ? p.toFixed(2) : String(parseFloat(p.toFixed(5)));
}

function purchaseQtyFor(line: BomLine, opts: SuggestOptions): number {
  return Math.max(1, opts.boardQty * line.qtyPerBoard);
}

function buildCandidate(
  part: Part,
  line: BomLine,
  opts: SuggestOptions,
  extraWarnings: string[],
  priceScore: number,
): Candidate {
  const purchaseQty = purchaseQtyFor(line, opts);
  const stockTarget = Math.max(1, purchaseQty * opts.stockMultiple);

  const reasons: string[] = [tierReason(part.tier)];
  const warnings: string[] = [...extraWarnings];
  let score = tierWeight(part.tier);

  score += Math.min(Math.max(part.stock, 0) / stockTarget, 1) * WEIGHT_STOCK_ADEQUACY_MAX;
  if (part.stock > stockTarget) {
    // log10-scaled depth bonus: maxes out at 100× the stock target.
    score += Math.min(WEIGHT_STOCK_DEPTH_MAX, Math.log10(part.stock / stockTarget) * 5);
  }
  reasons.push(`${formatStock(part.stock)} in stock`);
  if (part.stock > 0 && part.stock < stockTarget) {
    warnings.push(
      `stock risk: ${part.stock} available vs ${stockTarget} wanted (${purchaseQty} needed × ${opts.stockMultiple}× buffer)`,
    );
  }

  if (part.tier === "extended") warnings.push("extended part — +$3 loading fee");

  const unit = unitPriceAtQty(part, purchaseQty);
  if (unit === null) {
    warnings.push("price unknown");
  } else {
    if (part.priceBreaks.length === 0) warnings.push("no price breaks — using qty-1 unit price");
    reasons.push(`$${fmtUsd(unit)}/pc at qty ${purchaseQty}`);
  }
  score += priceScore;

  const partTol = partTolerancePct(part);
  const lineTol = line.parsed?.kind === "resistance" ? line.parsed.tolerancePct : undefined;
  if (
    partTol !== undefined &&
    (lineTol !== undefined ? partTol < lineTol : partTol <= 1)
  ) {
    score += WEIGHT_TOLERANCE_BONUS;
    reasons.push(`tight tolerance ±${partTol}%`);
  }

  return {
    part,
    score: round4(score),
    reasons,
    warnings,
    unitPriceAtQty: unit,
    lineCost: unit === null ? null : round4(unit * purchaseQty),
  };
}

function priceScoreFor(price: number | null, min: number, max: number): number {
  if (price === null) return 0;
  if (max === min) return WEIGHT_PRICE_MAX;
  return (WEIGHT_PRICE_MAX * (max - price)) / (max - min);
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (b.score !== a.score) return b.score - a.score;
  const pa = a.unitPriceAtQty ?? Number.POSITIVE_INFINITY;
  const pb = b.unitPriceAtQty ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;
  if (b.part.stock !== a.part.stock) return b.part.stock - a.part.stock;
  return a.part.lcscId - b.part.lcscId;
}

/** Filter, score, and rank parts for a BOM line. Returns top opts.maxCandidates. */
export function rankCandidates(line: BomLine, parts: Part[], opts: SuggestOptions): Candidate[] {
  const purchaseQty = purchaseQtyFor(line, opts);

  const seen = new Set<string>();
  const survivors: { part: Part; warnings: string[] }[] = [];
  for (const part of parts) {
    if (seen.has(part.lcsc)) continue;
    seen.add(part.lcsc);
    const res = applyHardFilters(line, part);
    if (res.dropReasons.length === 0) survivors.push({ part, warnings: res.warnings });
  }

  // Price score is relative to the surviving cohort at the purchase quantity.
  const prices = survivors.map((s) => unitPriceAtQty(s.part, purchaseQty));
  const nonNull = prices.filter((p): p is number => p !== null);
  const min = nonNull.length ? Math.min(...nonNull) : 0;
  const max = nonNull.length ? Math.max(...nonNull) : 0;

  const candidates = survivors.map((s, i) =>
    buildCandidate(s.part, line, opts, s.warnings, priceScoreFor(prices[i], min, max)),
  );
  candidates.sort(compareCandidates);
  return candidates.slice(0, Math.max(1, opts.maxCandidates));
}

/**
 * Evaluate a single known part (e.g. preassigned LCSC) WITHOUT hard-dropping:
 * filter violations become warnings instead.
 */
export function candidateForPart(part: Part, line: BomLine, opts: SuggestOptions): Candidate {
  const res = applyHardFilters(line, part);
  const unit = unitPriceAtQty(part, purchaseQtyFor(line, opts));
  return buildCandidate(
    part,
    line,
    opts,
    [...res.dropReasons, ...res.warnings],
    unit === null ? 0 : WEIGHT_PRICE_MAX,
  );
}
