import { describe, expect, it } from "vitest";
import type { Candidate, LineStatus, LineSuggestion, Part } from "../../src/types.js";
import {
  DEFAULT_SUGGEST_OPTIONS,
  estimateCost,
  LOADING_FEE_USD,
} from "../../src/engine/cost.js";

let seq = 1;
function makePart(overrides: Partial<Part> = {}): Part {
  const id = overrides.lcscId ?? seq++;
  return {
    lcsc: `C${id}`,
    lcscId: id,
    mfr: `MFR-${id}`,
    description: "generic part",
    package: "0603",
    stock: 100_000,
    tier: "basic",
    priceBreaks: [{ qFrom: 1, qTo: null, price: 0.01 }],
    unitPrice: 0.01,
    productUrl: `https://jlcpcb.com/partdetail/C${id}`,
    ...overrides,
  };
}

function makeCandidate(part: Part, lineCost: number | null): Candidate {
  return {
    part,
    score: 100,
    reasons: [],
    warnings: [],
    unitPriceAtQty: lineCost === null ? null : lineCost / 10,
    lineCost,
  };
}

function makeSuggestion(
  status: LineStatus,
  chosen?: Candidate,
  reference = `R${seq}`,
): LineSuggestion {
  return {
    line: {
      references: [reference],
      qtyPerBoard: 1,
      value: "10k",
      componentClass: "resistor",
      dnp: status === "skipped_dnp",
    },
    candidates: chosen ? [chosen] : [],
    chosen,
    status,
    notes: [],
  };
}

describe("estimateCost", () => {
  it("dedupes the loading fee by lcsc: same extended part on two lines is ONE fee", () => {
    const shared = makePart({ lcsc: "C500", lcscId: 500, tier: "extended" });
    const lines = [
      makeSuggestion("matched", makeCandidate(shared, 1)),
      makeSuggestion("matched", makeCandidate(shared, 2)),
    ];
    const cost = estimateCost(lines, 10);
    expect(cost.componentCostTotal).toBeCloseTo(3, 6); // both lines' component cost counts
    expect(cost.loadingFees).toBe(LOADING_FEE_USD); // …but the fee is charged once
    expect(cost.extendedCount).toBe(1);
    expect(cost.uniqueParts).toBe(1);
    expect(cost.total).toBeCloseTo(3 + LOADING_FEE_USD, 6);
    expect(cost.perBoard).toBeCloseTo((3 + LOADING_FEE_USD) / 10, 6);
  });

  it("charges one fee per DISTINCT extended part", () => {
    const lines = [
      makeSuggestion("matched", makeCandidate(makePart({ tier: "extended" }), 1)),
      makeSuggestion("matched", makeCandidate(makePart({ tier: "extended" }), 1)),
    ];
    const cost = estimateCost(lines, 10);
    expect(cost.loadingFees).toBe(2 * LOADING_FEE_USD);
    expect(cost.extendedCount).toBe(2);
  });

  it("basic and preferred parts incur no loading fee", () => {
    const lines = [
      makeSuggestion("matched", makeCandidate(makePart({ tier: "basic" }), 0.5)),
      makeSuggestion("matched", makeCandidate(makePart({ tier: "preferred" }), 0.7)),
    ];
    const cost = estimateCost(lines, 10);
    expect(cost.loadingFees).toBe(0);
    expect(cost.basicCount).toBe(1);
    expect(cost.preferredCount).toBe(1);
    expect(cost.extendedCount).toBe(0);
    expect(cost.componentCostTotal).toBeCloseTo(1.2, 6);
  });

  it("skipped_dnp and no_match lines contribute zero cost", () => {
    const lines = [
      makeSuggestion("matched", makeCandidate(makePart(), 1)),
      makeSuggestion("skipped_dnp"),
      makeSuggestion("no_match"),
    ];
    const cost = estimateCost(lines, 10);
    expect(cost.componentCostTotal).toBeCloseTo(1, 6);
    expect(cost.uniqueParts).toBe(1);
  });

  it("counts preassigned lines like matched ones", () => {
    const lines = [
      makeSuggestion("preassigned", makeCandidate(makePart({ tier: "extended" }), 2)),
    ];
    const cost = estimateCost(lines, 10);
    expect(cost.componentCostTotal).toBeCloseTo(2, 6);
    expect(cost.loadingFees).toBe(LOADING_FEE_USD);
  });

  it("null lineCost contributes zero but the part still counts as unique", () => {
    const lines = [
      makeSuggestion("needs_review", makeCandidate(makePart({ tier: "extended" }), null)),
    ];
    const cost = estimateCost(lines, 10);
    expect(cost.componentCostTotal).toBe(0);
    expect(cost.uniqueParts).toBe(1);
    expect(cost.loadingFees).toBe(LOADING_FEE_USD);
  });

  it("computes total and perBoard", () => {
    const lines = [
      makeSuggestion("matched", makeCandidate(makePart({ tier: "basic" }), 1.5)),
      makeSuggestion("matched", makeCandidate(makePart({ tier: "extended" }), 0.5)),
    ];
    const cost = estimateCost(lines, 5);
    expect(cost.boardQty).toBe(5);
    expect(cost.total).toBeCloseTo(2 + LOADING_FEE_USD, 6);
    expect(cost.perBoard).toBeCloseTo((2 + LOADING_FEE_USD) / 5, 6);
  });

  it("guards against boardQty 0", () => {
    const cost = estimateCost([], 0);
    expect(cost.perBoard).toBe(0);
    expect(cost.total).toBe(0);
  });
});

describe("DEFAULT_SUGGEST_OPTIONS", () => {
  it("matches the contract defaults", () => {
    expect(DEFAULT_SUGGEST_OPTIONS).toEqual({ boardQty: 10, stockMultiple: 5, maxCandidates: 5 });
  });
});
