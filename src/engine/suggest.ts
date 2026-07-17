/**
 * Suggestion flow: plan searches per BOM line, run them against a PartSearcher,
 * rank the results, and assemble BOM-level advice.
 */
import type {
  BomLine,
  BomSuggestion,
  Candidate,
  CapacitorSearchOptions,
  LineStatus,
  LineSuggestion,
  Part,
  ResistorSearchOptions,
  SearchOptions,
  SuggestOptions,
} from "../types.js";
import { candidateForPart, rankCandidates, STRICT_PACKAGE_CLASSES } from "./rank.js";
import { estimateCost } from "./cost.js";

/** Implemented by JlcClient; keeps the engine decoupled and testable. */
export interface PartSearcher {
  searchComponents(opts: SearchOptions): Promise<Part[]>;
  searchResistors(opts: ResistorSearchOptions): Promise<Part[]>;
  searchCapacitors(opts: CapacitorSearchOptions): Promise<Part[]>;
  getPart(lcsc: string | number): Promise<Part | null>;
}

const BOM_CONCURRENCY = 3;

function searchLimit(opts: SuggestOptions): number {
  return Math.max(opts.maxCandidates * 4, 20);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildTextQueries(line: BomLine): string[] {
  const value = line.value.trim();
  const queries: string[] = [];
  if (value && line.package) queries.push(`${value} ${line.package}`);
  if (value) {
    queries.push(value);
    for (const token of value.split(/\s+/)) {
      if (token.length >= 2) queries.push(token);
    }
  }
  return [...new Set(queries)];
}

/**
 * For "resistor"/"capacitor" the parametric endpoint is used first; queries[]
 * holds the text-search fallbacks. For "lcsc" queries[0] is the LCSC number.
 */
export function buildSearchPlan(line: BomLine): {
  strategy: "resistor" | "capacitor" | "text" | "lcsc";
  queries: string[];
} {
  if (line.lcsc) return { strategy: "lcsc", queries: [line.lcsc] };
  const queries = buildTextQueries(line);
  if (line.componentClass === "resistor" && line.parsed?.kind === "resistance") {
    return { strategy: "resistor", queries };
  }
  if (line.componentClass === "capacitor" && line.parsed?.kind === "capacitance") {
    return { strategy: "capacitor", queries };
  }
  return { strategy: "text", queries };
}

async function suggestPreassigned(
  line: BomLine,
  searcher: PartSearcher,
  opts: SuggestOptions,
): Promise<LineSuggestion> {
  const lcsc = line.lcsc as string;
  let part: Part | null = null;
  const notes: string[] = [];
  try {
    part = await searcher.getPart(lcsc);
  } catch (err) {
    notes.push(`lookup of preassigned ${lcsc} failed: ${errMsg(err)}`);
  }
  if (!part) {
    return {
      line,
      candidates: [],
      status: "no_match",
      notes: [`preassigned part ${lcsc} not found`, ...notes],
    };
  }
  const candidate = candidateForPart(part, line, opts);
  notes.unshift(`preassigned ${part.lcsc} (${part.mfr}) verified`);
  for (const warning of candidate.warnings) notes.push(`warning: ${warning}`);
  return { line, candidates: [candidate], chosen: candidate, status: "preassigned", notes };
}

export async function suggestForLine(
  line: BomLine,
  searcher: PartSearcher,
  opts: SuggestOptions,
): Promise<LineSuggestion> {
  if (line.dnp) {
    return { line, candidates: [], status: "skipped_dnp", notes: ["DNP — line skipped"] };
  }

  const plan = buildSearchPlan(line);
  if (plan.strategy === "lcsc") return suggestPreassigned(line, searcher, opts);

  const notes: string[] = [];
  const tried: string[] = [];
  let ranked: Candidate[] = [];
  let usedStrategy: "resistor" | "capacitor" | "text" = plan.strategy;
  let matchedVia = "";

  if (plan.strategy === "resistor" && line.parsed?.kind === "resistance") {
    tried.push(`parametric resistor search (${line.value}${line.package ? " " + line.package : ""})`);
    try {
      const parts = await searcher.searchResistors({
        ohms: line.parsed.ohms,
        package: line.package,
        maxTolerance:
          line.parsed.tolerancePct !== undefined ? line.parsed.tolerancePct / 100 : undefined,
        limit: searchLimit(opts),
      });
      ranked = rankCandidates(line, parts, opts);
      if (ranked.length > 0) matchedVia = "parametric resistor search";
    } catch (err) {
      notes.push(`parametric resistor search failed: ${errMsg(err)}`);
    }
  } else if (plan.strategy === "capacitor" && line.parsed?.kind === "capacitance") {
    tried.push(`parametric capacitor search (${line.value}${line.package ? " " + line.package : ""})`);
    try {
      const parts = await searcher.searchCapacitors({
        farads: line.parsed.farads,
        package: line.package,
        minVoltage: line.parsed.voltage,
        limit: searchLimit(opts),
      });
      ranked = rankCandidates(line, parts, opts);
      if (ranked.length > 0) matchedVia = "parametric capacitor search";
    } catch (err) {
      notes.push(`parametric capacitor search failed: ${errMsg(err)}`);
    }
  }

  if (ranked.length === 0) {
    for (const q of plan.queries) {
      tried.push(`text search "${q}"`);
      let parts: Part[];
      try {
        parts = await searcher.searchComponents({
          q,
          // Non-passive footprint names vary ("QFN-32" vs "QFN-32-EP(5x5)");
          // let rankCandidates apply the prefix-tolerant filter instead of the
          // client's exact-match one.
          package: STRICT_PACKAGE_CLASSES.has(line.componentClass) ? line.package : undefined,
          limit: searchLimit(opts),
        });
      } catch (err) {
        notes.push(`text search "${q}" failed: ${errMsg(err)}`);
        continue;
      }
      ranked = rankCandidates(line, parts, opts);
      if (ranked.length > 0) {
        usedStrategy = "text";
        matchedVia = `text search "${q}"`;
        break;
      }
    }
  }

  if (ranked.length === 0) {
    return {
      line,
      candidates: [],
      status: "no_match",
      notes: [`no candidates survived filters; tried: ${tried.join("; ")}`, ...notes],
    };
  }

  const chosen = ranked[0];
  let status: LineStatus = "matched";
  const reviewReasons: string[] = [];

  const hasStockWarning = chosen.warnings.some((w) => /stock/i.test(w));
  if (hasStockWarning && chosen.part.tier === "extended") {
    reviewReasons.push("stock warning on an extended part — verify availability");
  }
  if (
    usedStrategy === "text" &&
    (line.componentClass === "ic" ||
      line.componentClass === "connector" ||
      line.componentClass === "switch" ||
      line.componentClass === "other")
  ) {
    reviewReasons.push(`${line.componentClass} matched via free-text search — verify the part fits`);
  }
  if (chosen.warnings.some((w) => w.includes("verify footprint"))) {
    reviewReasons.push("package matched by prefix only — verify footprint compatibility");
  }
  if (
    (line.parsed?.kind === "resistance" || line.parsed?.kind === "capacitance") &&
    chosen.warnings.some((w) => w.includes("value unverified"))
  ) {
    reviewReasons.push(
      "value could not be verified from part data — confirm spec before ordering",
    );
  }
  if (chosen.unitPriceAtQty === null || chosen.unitPriceAtQty === 0) {
    reviewReasons.push("chosen candidate has zero/unknown price — verify pricing");
  }

  notes.unshift(`matched via ${matchedVia}`);
  if (reviewReasons.length > 0) {
    status = "needs_review";
    for (const reason of reviewReasons) notes.push(`needs review: ${reason}`);
  }

  return { line, candidates: ranked, chosen, status, notes };
}

// Tiny promise pool: preserves input order, at most `limit` in flight.
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function describeLine(s: LineSuggestion): string {
  return `${s.line.references.join(",")} (${s.line.value})`;
}

function consolidationHints(suggestions: LineSuggestion[]): string[] {
  const groups = new Map<string, { letter: string; display: string; packages: Set<string> }>();
  for (const s of suggestions) {
    const l = s.line;
    if (l.dnp || !l.package) continue;
    if (l.componentClass !== "resistor" && l.componentClass !== "capacitor") continue;
    const letter = l.componentClass === "resistor" ? "R" : "C";
    const valueKey =
      l.parsed?.kind === "resistance"
        ? `r:${l.parsed.ohms}`
        : l.parsed?.kind === "capacitance"
          ? `c:${l.parsed.farads}`
          : `v:${l.value.trim().toLowerCase()}`;
    const key = `${letter}|${valueKey}`;
    const group = groups.get(key) ?? { letter, display: l.value.trim(), packages: new Set<string>() };
    group.packages.add(l.package);
    groups.set(key, group);
  }
  const hints: string[] = [];
  for (const g of groups.values()) {
    if (g.packages.size > 1) {
      hints.push(
        `${g.letter} ${g.display} appears in ${listJoin([...g.packages].sort())} — consolidating saves a reel change`,
      );
    }
  }
  return hints;
}

export async function suggestForBom(
  lines: BomLine[],
  searcher: PartSearcher,
  opts: SuggestOptions,
): Promise<BomSuggestion> {
  const suggestions = await mapPool(lines, BOM_CONCURRENCY, (line) =>
    suggestForLine(line, searcher, opts),
  );
  const cost = estimateCost(suggestions, opts.boardQty);

  const notes: string[] = [];
  if (cost.extendedCount > 0) {
    notes.push(
      `${cost.extendedCount} extended part${cost.extendedCount === 1 ? "" : "s"} chosen — $${cost.loadingFees.toFixed(2)} in loading fees ($3 per unique extended part)`,
    );
  }
  notes.push(...consolidationHints(suggestions));

  const review = suggestions.filter((s) => s.status === "needs_review");
  if (review.length > 0) notes.push(`needs review: ${review.map(describeLine).join(", ")}`);
  const noMatch = suggestions.filter((s) => s.status === "no_match");
  if (noMatch.length > 0) notes.push(`no match found: ${noMatch.map(describeLine).join(", ")}`);

  return { lines: suggestions, cost, notes };
}
