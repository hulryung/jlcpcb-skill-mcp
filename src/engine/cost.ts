/**
 * Assembly cost estimation: component cost + JLCPCB loading fees.
 */
import type { CostBreakdown, LineSuggestion, Part, SuggestOptions } from "../types.js";

export const LOADING_FEE_USD = 3;

export const DEFAULT_SUGGEST_OPTIONS: SuggestOptions = Object.freeze({
  boardQty: 10,
  stockMultiple: 5,
  maxCandidates: 5,
});

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * componentCost from chosen candidates only; loading fee is $3 per UNIQUE
 * extended part (deduped by lcsc across lines — the same extended part on two
 * lines is one fee). skipped_dnp / no_match lines contribute zero cost.
 */
export function estimateCost(lines: LineSuggestion[], boardQty: number): CostBreakdown {
  const unique = new Map<string, Part>();
  let componentCostTotal = 0;

  for (const suggestion of lines) {
    if (suggestion.status === "skipped_dnp" || suggestion.status === "no_match") continue;
    const chosen = suggestion.chosen;
    if (!chosen) continue;
    componentCostTotal += chosen.lineCost ?? 0;
    unique.set(chosen.part.lcsc, chosen.part);
  }

  let basicCount = 0;
  let preferredCount = 0;
  let extendedCount = 0;
  for (const part of unique.values()) {
    if (part.tier === "basic") basicCount++;
    else if (part.tier === "preferred") preferredCount++;
    else extendedCount++;
  }

  const loadingFees = LOADING_FEE_USD * extendedCount;
  const total = round4(componentCostTotal + loadingFees);

  return {
    boardQty,
    componentCostTotal: round4(componentCostTotal),
    loadingFees,
    uniqueParts: unique.size,
    basicCount,
    preferredCount,
    extendedCount,
    total,
    perBoard: boardQty > 0 ? round4(total / boardQty) : 0,
  };
}
