import { describe, expect, it } from "vitest";
import type { BomLine, Part, SuggestOptions } from "../../src/types.js";
import {
  candidateForPart,
  rankCandidates,
  unitPriceAtQty,
  WEIGHT_PRICE_MAX,
  WEIGHT_STOCK_ADEQUACY_MAX,
  WEIGHT_TIER_BASIC,
  WEIGHT_TIER_PREFERRED,
  WEIGHT_TOLERANCE_BONUS,
} from "../../src/engine/rank.js";

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

function makeLine(overrides: Partial<BomLine> = {}): BomLine {
  return {
    references: ["R1"],
    qtyPerBoard: 1,
    value: "10k",
    package: "0603",
    componentClass: "resistor",
    dnp: false,
    ...overrides,
  };
}

const OPTS: SuggestOptions = { boardQty: 10, stockMultiple: 5, maxCandidates: 5 };

describe("unitPriceAtQty", () => {
  const breaks = [
    { qFrom: 1, qTo: 99, price: 0.05 },
    { qFrom: 100, qTo: 499, price: 0.03 },
    { qFrom: 500, qTo: null, price: 0.01 },
  ];

  it("returns unitPrice when priceBreaks empty", () => {
    expect(unitPriceAtQty(makePart({ priceBreaks: [], unitPrice: 0.42 }), 10)).toBe(0.42);
  });

  it("returns null when priceBreaks empty and unitPrice null", () => {
    expect(unitPriceAtQty(makePart({ priceBreaks: [], unitPrice: null }), 10)).toBeNull();
  });

  it("picks the break containing qty", () => {
    const part = makePart({ priceBreaks: breaks });
    expect(unitPriceAtQty(part, 50)).toBe(0.05);
    expect(unitPriceAtQty(part, 200)).toBe(0.03);
  });

  it("qty exactly at qFrom boundary picks that break", () => {
    const part = makePart({ priceBreaks: breaks });
    expect(unitPriceAtQty(part, 100)).toBe(0.03);
    expect(unitPriceAtQty(part, 500)).toBe(0.01);
  });

  it("qty exactly at qTo boundary picks that break", () => {
    const part = makePart({ priceBreaks: breaks });
    expect(unitPriceAtQty(part, 99)).toBe(0.05);
    expect(unitPriceAtQty(part, 499)).toBe(0.03);
  });

  it("qty above all breaks uses the last break", () => {
    const part = makePart({
      priceBreaks: [
        { qFrom: 1, qTo: 99, price: 0.05 },
        { qFrom: 100, qTo: 499, price: 0.03 },
      ],
    });
    expect(unitPriceAtQty(part, 10_000)).toBe(0.03);
  });

  it("qty below the first break uses the first break", () => {
    const part = makePart({ priceBreaks: [{ qFrom: 100, qTo: null, price: 0.03 }] });
    expect(unitPriceAtQty(part, 1)).toBe(0.03);
  });

  it("qty in a gap between breaks uses the last applicable break", () => {
    const part = makePart({
      priceBreaks: [
        { qFrom: 1, qTo: 99, price: 0.05 },
        { qFrom: 200, qTo: null, price: 0.02 },
      ],
    });
    expect(unitPriceAtQty(part, 150)).toBe(0.05);
  });

  it("handles unsorted priceBreaks defensively", () => {
    const part = makePart({ priceBreaks: [breaks[2], breaks[0], breaks[1]] });
    expect(unitPriceAtQty(part, 200)).toBe(0.03);
  });
});

describe("rankCandidates hard filters", () => {
  it("drops out-of-stock parts", () => {
    const line = makeLine({ package: undefined });
    const ranked = rankCandidates(line, [makePart({ stock: 0 }), makePart({ stock: 10 })], OPTS);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].part.stock).toBe(10);
  });

  it("drops package mismatches when line.package is known", () => {
    const line = makeLine({ package: "0603" });
    const keep = makePart({ package: "0603" });
    const drop = makePart({ package: "0805" });
    const ranked = rankCandidates(line, [keep, drop], OPTS);
    expect(ranked.map((c) => c.part.lcsc)).toEqual([keep.lcsc]);
  });

  it("treats R0603/r0603 as aliases of 0603", () => {
    const line = makeLine({ package: "0603" });
    const a = makePart({ package: "R0603" });
    const b = makePart({ package: "r0603" });
    expect(rankCandidates(line, [a, b], OPTS)).toHaveLength(2);
  });

  it("matches packages case-insensitively", () => {
    const line = makeLine({ package: "SOT-23", componentClass: "transistor", value: "SS8050" });
    const part = makePart({ package: "sot-23" });
    expect(rankCandidates(line, [part], OPTS)).toHaveLength(1);
  });

  it("keeps parts with empty package but warns 'package unverified'", () => {
    const line = makeLine({ package: "0603" });
    const part = makePart({ package: "" });
    const ranked = rankCandidates(line, [part], OPTS);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].warnings.some((w) => w.includes("package unverified"))).toBe(true);
  });

  it("drops resistance mismatches beyond ±0.5%", () => {
    const line = makeLine({ parsed: { kind: "resistance", ohms: 10_000 } });
    const exact = makePart({ attributes: { Resistance: "10kΩ" } });
    const close = makePart({ attributes: { Resistance: "10.02kΩ" } }); // 0.2%
    const off = makePart({ attributes: { Resistance: "10.1kΩ" } }); // 1%
    const wrong = makePart({ attributes: { Resistance: "9.1kΩ" } });
    const ranked = rankCandidates(line, [exact, close, off, wrong], OPTS);
    const kept = ranked.map((c) => c.part.lcsc);
    expect(kept).toContain(exact.lcsc);
    expect(kept).toContain(close.lcsc);
    expect(kept).not.toContain(off.lcsc);
    expect(kept).not.toContain(wrong.lcsc);
  });

  it("reads resistance from the description when attributes are missing", () => {
    const line = makeLine({ parsed: { kind: "resistance", ohms: 10_000 } });
    const good = makePart({ description: "10kΩ ±1% 100mW Thick Film Resistor 0603" });
    const bad = makePart({ description: "22kΩ ±1% 100mW Thick Film Resistor 0603" });
    const ranked = rankCandidates(line, [good, bad], OPTS);
    expect(ranked.map((c) => c.part.lcsc)).toEqual([good.lcsc]);
  });

  it("drops capacitance mismatches beyond ±5% (float-safe across unit spellings)", () => {
    const line = makeLine({
      componentClass: "capacitor",
      value: "100nF",
      parsed: { kind: "capacitance", farads: 100e-9 },
    });
    const sameMicro = makePart({ attributes: { Capacitance: "0.1uF" } });
    const close = makePart({ attributes: { Capacitance: "102nF" } }); // 2%
    const off = makePart({ attributes: { Capacitance: "110nF" } }); // 10%
    const ranked = rankCandidates(line, [sameMicro, close, off], OPTS);
    const kept = ranked.map((c) => c.part.lcsc);
    expect(kept).toContain(sameMicro.lcsc);
    expect(kept).toContain(close.lcsc);
    expect(kept).not.toContain(off.lcsc);
  });

  it("keeps unverifiable values with a 'value unverified' warning", () => {
    const line = makeLine({ parsed: { kind: "resistance", ohms: 10_000 } });
    const part = makePart({ description: "some resistor, no value stated" });
    const ranked = rankCandidates(line, [part], OPTS);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].warnings.some((w) => w.includes("value unverified"))).toBe(true);
  });

  it("enforces tolerance stricter-or-equal when the line specifies one", () => {
    const line = makeLine({ parsed: { kind: "resistance", ohms: 10_000, tolerancePct: 1 } });
    const tighter = makePart({ attributes: { Resistance: "10kΩ", Tolerance: "±0.5%" } });
    const equal = makePart({ attributes: { Resistance: "10kΩ", Tolerance: "±1%" } });
    const looser = makePart({ attributes: { Resistance: "10kΩ", Tolerance: "±5%" } });
    const ranked = rankCandidates(line, [tighter, equal, looser], OPTS);
    const kept = ranked.map((c) => c.part.lcsc);
    expect(kept).toContain(tighter.lcsc);
    expect(kept).toContain(equal.lcsc);
    expect(kept).not.toContain(looser.lcsc);
  });
});

describe("rankCandidates scoring", () => {
  it("tier ordering beats price: expensive basic outranks cheap extended", () => {
    const line = makeLine();
    const basic = makePart({
      tier: "basic",
      priceBreaks: [{ qFrom: 1, qTo: null, price: 0.02 }],
      unitPrice: 0.02,
    });
    const extended = makePart({
      tier: "extended",
      priceBreaks: [{ qFrom: 1, qTo: null, price: 0.001 }],
      unitPrice: 0.001,
    });
    const ranked = rankCandidates(line, [extended, basic], OPTS);
    expect(ranked[0].part.lcsc).toBe(basic.lcsc);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("preferred ranks between basic and extended", () => {
    const line = makeLine();
    const basic = makePart({ tier: "basic" });
    const preferred = makePart({ tier: "preferred" });
    const extended = makePart({ tier: "extended" });
    const ranked = rankCandidates(line, [extended, preferred, basic], OPTS);
    expect(ranked.map((c) => c.part.tier)).toEqual(["basic", "preferred", "extended"]);
  });

  it("stock adequacy scales: deeper stock scores higher, low stock warns", () => {
    // purchaseQty = 10 × 1 = 10, stockTarget = 10 × 5 = 50
    const line = makeLine();
    const low = makePart({ stock: 25 });
    const deep = makePart({ stock: 5000 });
    const ranked = rankCandidates(line, [low, deep], OPTS);
    expect(ranked[0].part.lcsc).toBe(deep.lcsc);
    const lowCand = ranked.find((c) => c.part.lcsc === low.lcsc)!;
    expect(lowCand.warnings.some((w) => w.includes("stock risk"))).toBe(true);
    expect(ranked[0].warnings.some((w) => w.includes("stock"))).toBe(false);
  });

  it("score composition matches the exported weights", () => {
    // stock exactly at target (50): full adequacy, no depth bonus.
    // Sole candidate with a known price gets full price score.
    const line = makeLine();
    const part = makePart({ stock: 50 });
    const [cand] = rankCandidates(line, [part], OPTS);
    expect(cand.score).toBeCloseTo(
      WEIGHT_TIER_BASIC + WEIGHT_STOCK_ADEQUACY_MAX + WEIGHT_PRICE_MAX,
      6,
    );
  });

  it("adds the tolerance bonus for tighter-than-required tolerance", () => {
    const line = makeLine({ parsed: { kind: "resistance", ohms: 10_000, tolerancePct: 1 } });
    const plain = makePart({ attributes: { Resistance: "10kΩ", Tolerance: "±1%" }, stock: 50 });
    const tight = makePart({ attributes: { Resistance: "10kΩ", Tolerance: "±0.5%" }, stock: 50 });
    const ranked = rankCandidates(line, [plain, tight], OPTS);
    expect(ranked[0].part.lcsc).toBe(tight.lcsc);
    expect(ranked[0].score - ranked[1].score).toBeCloseTo(WEIGHT_TOLERANCE_BONUS, 6);
  });

  it("prices at the purchase quantity (boardQty × qtyPerBoard) and sets lineCost", () => {
    const line = makeLine({ qtyPerBoard: 2 }); // purchaseQty = 20
    const part = makePart({
      priceBreaks: [
        { qFrom: 1, qTo: 19, price: 0.1 },
        { qFrom: 20, qTo: null, price: 0.04 },
      ],
    });
    const [cand] = rankCandidates(line, [part], OPTS);
    expect(cand.unitPriceAtQty).toBe(0.04);
    expect(cand.lineCost).toBeCloseTo(0.8, 6);
  });

  it("cheaper candidate gets the higher price score (same tier/stock)", () => {
    const line = makeLine();
    const cheap = makePart({ priceBreaks: [{ qFrom: 1, qTo: null, price: 0.005 }] });
    const dear = makePart({ priceBreaks: [{ qFrom: 1, qTo: null, price: 0.05 }] });
    const ranked = rankCandidates(line, [dear, cheap], OPTS);
    expect(ranked[0].part.lcsc).toBe(cheap.lcsc);
    expect(ranked[0].score - ranked[1].score).toBeCloseTo(WEIGHT_PRICE_MAX, 6);
  });

  it("warns '+$3 loading fee' on extended parts and 'price unknown' on missing price", () => {
    const line = makeLine({ package: undefined });
    const part = makePart({ tier: "extended", priceBreaks: [], unitPrice: null });
    const [cand] = rankCandidates(line, [part], OPTS);
    expect(cand.warnings.some((w) => w.includes("+$3 loading fee"))).toBe(true);
    expect(cand.warnings.some((w) => w.includes("price unknown"))).toBe(true);
    expect(cand.unitPriceAtQty).toBeNull();
    expect(cand.lineCost).toBeNull();
  });

  it("includes human-readable reasons", () => {
    const line = makeLine();
    const part = makePart({ stock: 37_000_000 });
    const [cand] = rankCandidates(line, [part], OPTS);
    expect(cand.reasons).toContain("Basic part — no loading fee");
    expect(cand.reasons.some((r) => r.includes("37M in stock"))).toBe(true);
  });

  it("caps results at maxCandidates", () => {
    const line = makeLine({ package: undefined });
    const parts = Array.from({ length: 10 }, () => makePart());
    const ranked = rankCandidates(line, parts, { ...OPTS, maxCandidates: 3 });
    expect(ranked).toHaveLength(3);
  });

  it("dedupes parts by lcsc", () => {
    const line = makeLine({ package: undefined });
    const part = makePart();
    const ranked = rankCandidates(line, [part, { ...part }], OPTS);
    expect(ranked).toHaveLength(1);
  });

  it("returns [] for empty input", () => {
    expect(rankCandidates(makeLine(), [], OPTS)).toEqual([]);
  });
});

describe("candidateForPart (lenient evaluation for preassigned parts)", () => {
  it("does not drop an out-of-stock part but warns", () => {
    const line = makeLine();
    const part = makePart({ stock: 0 });
    const cand = candidateForPart(part, line, OPTS);
    expect(cand.warnings.some((w) => w.includes("out of stock"))).toBe(true);
  });

  it("turns package mismatch into a warning instead of dropping", () => {
    const line = makeLine({ package: "0603" });
    const part = makePart({ package: "0805" });
    const cand = candidateForPart(part, line, OPTS);
    expect(cand.warnings.some((w) => w.includes("package mismatch"))).toBe(true);
  });

  it("still applies tier weights", () => {
    const line = makeLine({ package: undefined });
    const cand = candidateForPart(makePart({ tier: "preferred", stock: 50 }), line, OPTS);
    expect(cand.score).toBeCloseTo(WEIGHT_TIER_PREFERRED + WEIGHT_STOCK_ADEQUACY_MAX + WEIGHT_PRICE_MAX, 6);
  });
});
