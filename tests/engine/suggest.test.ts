import { describe, expect, it } from "vitest";
import type { BomLine, Part, SuggestOptions } from "../../src/types.js";
import {
  buildSearchPlan,
  suggestForBom,
  suggestForLine,
  type PartSearcher,
} from "../../src/engine/suggest.js";

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
    parsed: { kind: "resistance", ohms: 10_000 },
    dnp: false,
    ...overrides,
  };
}

const OPTS: SuggestOptions = { boardQty: 10, stockMultiple: 5, maxCandidates: 5 };

/** Searcher stub whose every method fails unless overridden. */
function stubSearcher(overrides: Partial<PartSearcher> = {}): PartSearcher {
  const fail = (name: string) => async () => {
    throw new Error(`unexpected call: ${name}`);
  };
  return {
    searchComponents: fail("searchComponents"),
    searchResistors: fail("searchResistors"),
    searchCapacitors: fail("searchCapacitors"),
    getPart: fail("getPart"),
    ...overrides,
  };
}

describe("buildSearchPlan", () => {
  it("uses lcsc strategy when the line is preassigned", () => {
    const plan = buildSearchPlan(makeLine({ lcsc: "C25804" }));
    expect(plan).toEqual({ strategy: "lcsc", queries: ["C25804"] });
  });

  it("uses resistor strategy for parsed resistors", () => {
    const plan = buildSearchPlan(makeLine());
    expect(plan.strategy).toBe("resistor");
    expect(plan.queries).toEqual(["10k 0603", "10k"]);
  });

  it("uses capacitor strategy for parsed capacitors", () => {
    const plan = buildSearchPlan(
      makeLine({
        componentClass: "capacitor",
        value: "100nF",
        parsed: { kind: "capacitance", farads: 1e-7 },
      }),
    );
    expect(plan.strategy).toBe("capacitor");
  });

  it("falls back to text for resistors without a parsed value", () => {
    expect(buildSearchPlan(makeLine({ parsed: undefined })).strategy).toBe("text");
    expect(buildSearchPlan(makeLine({ parsed: { kind: "raw", text: "array" } })).strategy).toBe("text");
  });

  it("builds text queries: value+package, value, then tokens (deduped)", () => {
    const plan = buildSearchPlan(
      makeLine({
        componentClass: "ic",
        value: "NE555 timer",
        package: "SOIC-8",
        parsed: undefined,
      }),
    );
    expect(plan.strategy).toBe("text");
    expect(plan.queries).toEqual(["NE555 timer SOIC-8", "NE555 timer", "NE555", "timer"]);
  });

  it("omits the package query when package is unknown", () => {
    const plan = buildSearchPlan(makeLine({ package: undefined, parsed: undefined }));
    expect(plan.queries).toEqual(["10k"]);
  });
});

describe("suggestForLine", () => {
  it("skips DNP lines without touching the searcher", async () => {
    const res = await suggestForLine(makeLine({ dnp: true, lcsc: "C1" }), stubSearcher(), OPTS);
    expect(res.status).toBe("skipped_dnp");
    expect(res.candidates).toEqual([]);
    expect(res.chosen).toBeUndefined();
  });

  it("verifies preassigned parts via getPart and keeps status preassigned", async () => {
    const part = makePart({ lcsc: "C99", lcscId: 99, tier: "extended", stock: 12 });
    const calls: (string | number)[] = [];
    const searcher = stubSearcher({
      getPart: async (lcsc) => {
        calls.push(lcsc);
        return part;
      },
    });
    const res = await suggestForLine(makeLine({ lcsc: "C99" }), searcher, OPTS);
    expect(calls).toEqual(["C99"]);
    expect(res.status).toBe("preassigned");
    expect(res.chosen?.part.lcsc).toBe("C99");
    // still verifies stock + tier: low stock (12 < 50) and extended fee warnings
    expect(res.chosen?.warnings.some((w) => w.includes("stock risk"))).toBe(true);
    expect(res.chosen?.warnings.some((w) => w.includes("loading fee"))).toBe(true);
    expect(res.notes.some((n) => n.includes("stock risk"))).toBe(true);
  });

  it("reports no_match when the preassigned part is not found", async () => {
    const searcher = stubSearcher({ getPart: async () => null });
    const res = await suggestForLine(makeLine({ lcsc: "C404" }), searcher, OPTS);
    expect(res.status).toBe("no_match");
    expect(res.notes.some((n) => n.includes("C404"))).toBe(true);
  });

  it("uses parametric resistor search with ohms/package/maxTolerance", async () => {
    const received: unknown[] = [];
    const searcher = stubSearcher({
      searchResistors: async (opts) => {
        received.push(opts);
        return [makePart({ attributes: { Resistance: "10kΩ", Tolerance: "±1%" } })];
      },
    });
    const line = makeLine({ parsed: { kind: "resistance", ohms: 10_000, tolerancePct: 1 } });
    const res = await suggestForLine(line, searcher, OPTS);
    expect(received[0]).toMatchObject({ ohms: 10_000, package: "0603", maxTolerance: 0.01 });
    expect(res.status).toBe("matched");
    expect(res.chosen).toBeDefined();
    expect(res.notes.some((n) => n.includes("parametric resistor search"))).toBe(true);
  });

  it("uses parametric capacitor search with farads/package/minVoltage", async () => {
    const received: unknown[] = [];
    const searcher = stubSearcher({
      searchCapacitors: async (opts) => {
        received.push(opts);
        return [makePart({ attributes: { Capacitance: "100nF" } })];
      },
    });
    const line = makeLine({
      componentClass: "capacitor",
      value: "100nF",
      parsed: { kind: "capacitance", farads: 1e-7, voltage: 50 },
    });
    const res = await suggestForLine(line, searcher, OPTS);
    expect(received[0]).toMatchObject({ farads: 1e-7, package: "0603", minVoltage: 50 });
    expect(res.status).toBe("matched");
  });

  it("falls back to text search when parametric search returns nothing", async () => {
    const textQueries: string[] = [];
    const searcher = stubSearcher({
      searchResistors: async () => [],
      searchComponents: async (opts) => {
        textQueries.push(opts.q ?? "");
        return [makePart({ attributes: { Resistance: "10kΩ" } })];
      },
    });
    const res = await suggestForLine(makeLine(), searcher, OPTS);
    expect(textQueries[0]).toBe("10k 0603");
    expect(res.status).toBe("matched");
    expect(res.notes.some((n) => n.includes('text search "10k 0603"'))).toBe(true);
  });

  it("falls back to text search when parametric search throws, and notes the failure", async () => {
    const searcher = stubSearcher({
      searchResistors: async () => {
        throw new Error("api down");
      },
      searchComponents: async () => [makePart({ attributes: { Resistance: "10kΩ" } })],
    });
    const res = await suggestForLine(makeLine(), searcher, OPTS);
    expect(res.status).toBe("matched");
    expect(res.notes.some((n) => n.includes("api down"))).toBe(true);
  });

  it("returns no_match with the tried queries when nothing survives", async () => {
    const searcher = stubSearcher({
      searchResistors: async () => [],
      searchComponents: async () => [],
    });
    const res = await suggestForLine(makeLine(), searcher, OPTS);
    expect(res.status).toBe("no_match");
    expect(res.chosen).toBeUndefined();
    expect(res.notes[0]).toContain('text search "10k 0603"');
    expect(res.notes[0]).toContain("parametric resistor search");
  });

  it("needs_review: extended chosen part with a stock warning", async () => {
    const searcher = stubSearcher({
      searchResistors: async () => [
        makePart({ tier: "extended", stock: 20, attributes: { Resistance: "10kΩ" } }),
      ],
    });
    const res = await suggestForLine(makeLine(), searcher, OPTS);
    expect(res.status).toBe("needs_review");
    expect(res.notes.some((n) => n.includes("needs review"))).toBe(true);
  });

  it("matched (not needs_review): basic part with plenty of stock", async () => {
    const searcher = stubSearcher({
      searchResistors: async () => [makePart({ attributes: { Resistance: "10kΩ" } })],
    });
    const res = await suggestForLine(makeLine(), searcher, OPTS);
    expect(res.status).toBe("matched");
  });

  it("needs_review: IC matched via text strategy", async () => {
    const searcher = stubSearcher({
      searchComponents: async () => [makePart({ package: "SOIC-8", stock: 50_000 })],
    });
    const line = makeLine({
      componentClass: "ic",
      value: "NE555",
      package: "SOIC-8",
      parsed: undefined,
    });
    const res = await suggestForLine(line, searcher, OPTS);
    expect(res.status).toBe("needs_review");
    expect(res.notes.some((n) => n.includes("free-text"))).toBe(true);
  });

  it("matched resistor via text fallback does NOT trigger the fuzzy-IC rule", async () => {
    const searcher = stubSearcher({
      searchResistors: async () => [],
      searchComponents: async () => [makePart({ attributes: { Resistance: "10kΩ" } })],
    });
    const res = await suggestForLine(makeLine(), searcher, OPTS);
    expect(res.status).toBe("matched");
  });

  it("needs_review: resistor whose value could not be verified from part data", async () => {
    // Part has no attributes and no parseable resistance in the description.
    const searcher = stubSearcher({
      searchResistors: async () => [makePart({ description: "mystery component" })],
    });
    const res = await suggestForLine(makeLine(), searcher, OPTS);
    expect(res.status).toBe("needs_review");
    expect(res.chosen?.warnings.some((w) => w.includes("value unverified"))).toBe(true);
    expect(
      res.notes.some((n) =>
        n.includes("value could not be verified from part data — confirm spec before ordering"),
      ),
    ).toBe(true);
  });

  it("needs_review: capacitor whose value could not be verified from part data", async () => {
    const searcher = stubSearcher({
      searchCapacitors: async () => [makePart({ description: "mystery component" })],
    });
    const line = makeLine({
      references: ["C1"],
      componentClass: "capacitor",
      value: "100nF",
      parsed: { kind: "capacitance", farads: 1e-7 },
    });
    const res = await suggestForLine(line, searcher, OPTS);
    expect(res.status).toBe("needs_review");
    expect(
      res.notes.some((n) =>
        n.includes("value could not be verified from part data — confirm spec before ordering"),
      ),
    ).toBe(true);
  });

  it("matched: verified value does not trigger the value-unverified review", async () => {
    const searcher = stubSearcher({
      searchResistors: async () => [makePart({ attributes: { Resistance: "10kΩ" } })],
    });
    const res = await suggestForLine(makeLine(), searcher, OPTS);
    expect(res.status).toBe("matched");
    expect(res.notes.some((n) => n.includes("value could not be verified"))).toBe(false);
  });

  it("needs_review: zero-price candidate chosen", async () => {
    const searcher = stubSearcher({
      searchResistors: async () => [
        makePart({
          priceBreaks: [{ qFrom: 1, qTo: null, price: 0 }],
          unitPrice: 0,
          attributes: { Resistance: "10kΩ" },
        }),
      ],
    });
    const res = await suggestForLine(makeLine(), searcher, OPTS);
    expect(res.status).toBe("needs_review");
    expect(res.notes.some((n) => n.includes("price"))).toBe(true);
  });
});

describe("suggestForBom", () => {
  it("runs at most 3 searches concurrently and preserves line order", async () => {
    let active = 0;
    let peak = 0;
    const searcher = stubSearcher({
      searchResistors: async (opts) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return [
          makePart({ attributes: { Resistance: `${(opts.ohms ?? 0) / 1000}kΩ` } }),
        ];
      },
    });
    const lines = Array.from({ length: 7 }, (_, i) =>
      makeLine({
        references: [`R${i + 1}`],
        value: `${i + 1}k`,
        parsed: { kind: "resistance", ohms: (i + 1) * 1000 },
      }),
    );
    const res = await suggestForBom(lines, searcher, OPTS);
    expect(peak).toBe(3);
    expect(res.lines.map((s) => s.line.references[0])).toEqual([
      "R1",
      "R2",
      "R3",
      "R4",
      "R5",
      "R6",
      "R7",
    ]);
    expect(res.lines.every((s) => s.status === "matched")).toBe(true);
  });

  it("notes extended-part count with total loading fees (deduped by lcsc)", async () => {
    const shared = makePart({
      lcsc: "C777",
      lcscId: 777,
      tier: "extended",
      attributes: { Resistance: "10kΩ" },
    });
    const searcher = stubSearcher({ searchResistors: async () => [shared] });
    const lines = [
      makeLine({ references: ["R1"] }),
      makeLine({ references: ["R2"], package: "0603" }),
    ];
    const res = await suggestForBom(lines, searcher, OPTS);
    expect(res.cost.extendedCount).toBe(1);
    expect(res.cost.loadingFees).toBe(3);
    expect(res.notes.some((n) => n.includes("1 extended part") && n.includes("$3.00"))).toBe(true);
  });

  it("emits a consolidation hint for the same value in different packages", async () => {
    const searcher = stubSearcher({
      searchResistors: async (opts) => [
        makePart({ package: opts.package ?? "0603", attributes: { Resistance: "10kΩ" } }),
      ],
    });
    const lines = [
      makeLine({ references: ["R1"], package: "0603" }),
      makeLine({ references: ["R2"], package: "0805" }),
    ];
    const res = await suggestForBom(lines, searcher, OPTS);
    expect(
      res.notes.some((n) =>
        n.includes("R 10k appears in 0603 and 0805") && n.includes("consolidating"),
      ),
    ).toBe(true);
  });

  it("lists needs_review and no_match lines in the notes", async () => {
    const searcher = stubSearcher({
      searchComponents: async (opts) =>
        opts.q?.startsWith("NE555") ? [makePart({ package: "SOIC-8" })] : [],
    });
    const lines = [
      makeLine({
        references: ["U1"],
        componentClass: "ic",
        value: "NE555",
        package: "SOIC-8",
        parsed: undefined,
      }),
      makeLine({
        references: ["J1"],
        componentClass: "connector",
        value: "USB4125",
        package: undefined,
        parsed: undefined,
      }),
    ];
    const res = await suggestForBom(lines, searcher, OPTS);
    expect(res.lines[0].status).toBe("needs_review");
    expect(res.lines[1].status).toBe("no_match");
    expect(res.notes.some((n) => n.includes("needs review") && n.includes("U1"))).toBe(true);
    expect(res.notes.some((n) => n.includes("no match") && n.includes("J1"))).toBe(true);
  });

  it("integrates cost: dnp and no_match lines cost nothing", async () => {
    const searcher = stubSearcher({
      searchResistors: async () => [
        makePart({
          lcsc: "C10",
          lcscId: 10,
          priceBreaks: [{ qFrom: 1, qTo: null, price: 0.02 }],
          attributes: { Resistance: "10kΩ" },
        }),
      ],
      searchComponents: async () => [],
    });
    const lines = [
      makeLine({ references: ["R1"] }), // matched: 10 pcs × $0.02 = $0.20
      makeLine({ references: ["R2"], dnp: true }),
      makeLine({
        references: ["U1"],
        componentClass: "ic",
        value: "XYZ",
        package: undefined,
        parsed: undefined,
      }),
    ];
    const res = await suggestForBom(lines, searcher, OPTS);
    expect(res.cost.componentCostTotal).toBeCloseTo(0.2, 6);
    expect(res.cost.uniqueParts).toBe(1);
    expect(res.cost.total).toBeCloseTo(0.2, 6);
  });
});
