import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  normalizeCapacitor,
  normalizeComponent,
  normalizeResistor,
  parsePriceBreaks,
  toLcscId,
} from "../../src/jlc/normalize.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/jlc", import.meta.url));

function fixture(name: string): any {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

describe("toLcscId", () => {
  it("parses canonical C-prefixed strings", () => {
    expect(toLcscId("C25804")).toBe(25804);
    expect(toLcscId("c7593")).toBe(7593);
  });

  it("parses bare digit strings and numbers", () => {
    expect(toLcscId("25804")).toBe(25804);
    expect(toLcscId(25804)).toBe(25804);
  });

  it("tolerates surrounding whitespace", () => {
    expect(toLcscId("  C123 ")).toBe(123);
  });

  it("throws on garbage", () => {
    for (const bad of ["", "C", "CX123", "12a4", "C-12", "hello", "C12.5", "C12 34"]) {
      expect(() => toLcscId(bad), JSON.stringify(bad)).toThrow(/Invalid LCSC/);
    }
    expect(() => toLcscId(-5)).toThrow(/Invalid LCSC/);
    expect(() => toLcscId(0)).toThrow(/Invalid LCSC/);
    expect(() => toLcscId(3.5)).toThrow(/Invalid LCSC/);
    expect(() => toLcscId(NaN)).toThrow(/Invalid LCSC/);
  });
});

describe("parsePriceBreaks", () => {
  it("wraps a single number into one open-ended break", () => {
    expect(parsePriceBreaks(0.091)).toEqual([{ qFrom: 1, qTo: null, price: 0.091 }]);
  });

  it("parses a real price-break JSON string from /components/list.json", () => {
    const row = fixture("components-c7593.json").components[0];
    const breaks = parsePriceBreaks(row.price);
    expect(breaks).toHaveLength(6);
    expect(breaks[0]).toEqual({ qFrom: 1, qTo: 49, price: 0.091 });
    expect(breaks[5]).toEqual({ qFrom: 5000, qTo: null, price: 0.049 });
  });

  it("accepts an already-parsed array and sorts by qFrom", () => {
    const breaks = parsePriceBreaks([
      { qFrom: 100, qTo: null, price: 0.02 },
      { qFrom: 1, qTo: 99, price: 0.05 },
    ]);
    expect(breaks.map((b) => b.qFrom)).toEqual([1, 100]);
  });

  it("parses a numeric string as a single price", () => {
    expect(parsePriceBreaks("0.05")).toEqual([{ qFrom: 1, qTo: null, price: 0.05 }]);
  });

  it("returns [] for garbage, null, undefined, empty string", () => {
    expect(parsePriceBreaks("not json")).toEqual([]);
    expect(parsePriceBreaks(null)).toEqual([]);
    expect(parsePriceBreaks(undefined)).toEqual([]);
    expect(parsePriceBreaks("")).toEqual([]);
    expect(parsePriceBreaks({ qFrom: 1 })).toEqual([]);
    expect(parsePriceBreaks(NaN)).toEqual([]);
    expect(parsePriceBreaks(-1)).toEqual([]);
  });

  it("skips rows with unusable prices but keeps valid siblings", () => {
    const breaks = parsePriceBreaks([
      { qFrom: 1, qTo: 99, price: "bogus" },
      { qFrom: 100, qTo: null, price: 0.01 },
      null,
      "junk",
    ]);
    expect(breaks).toEqual([{ qFrom: 100, qTo: null, price: 0.01 }]);
  });

  it("defaults a missing/invalid qFrom to 1 and non-numeric qTo to null", () => {
    expect(parsePriceBreaks([{ price: 0.5, qTo: "x" }])).toEqual([
      { qFrom: 1, qTo: null, price: 0.5 },
    ]);
  });
});

describe("normalizeComponent", () => {
  it("normalizes a rich /components/list.json row (price-break string, category, preferred tier)", () => {
    const part = normalizeComponent(fixture("components-c7593.json").components[0]);
    expect(part.lcsc).toBe("C7593");
    expect(part.lcscId).toBe(7593);
    expect(part.mfr).toBe("NE555DR");
    expect(part.package).toBe("SOIC-8");
    expect(part.tier).toBe("preferred");
    expect(part.stock).toBe(322212);
    expect(part.priceBreaks).toHaveLength(6);
    expect(part.unitPrice).toBeCloseTo(0.091);
    expect(part.category).toBe("Clock and Timing");
    expect(part.subcategory).toBe("Timers / Clock Oscillators");
    expect(part.productUrl).toBe("https://jlcpcb.com/partdetail/C7593");
  });

  it("normalizes an /api/search row (single numeric price, no category)", () => {
    const part = normalizeComponent(fixture("api-search-c7593.json").components[0]);
    expect(part.lcsc).toBe("C7593");
    expect(part.priceBreaks).toEqual([{ qFrom: 1, qTo: null, price: 0.091 }]);
    expect(part.unitPrice).toBeCloseTo(0.091);
    expect(part.category).toBeUndefined();
  });

  it("maps tier flags: basic > preferred > extended", () => {
    const basic = normalizeComponent(fixture("components-c25804.json").components[0]);
    expect(basic.tier).toBe("basic");
    expect(normalizeComponent({ lcsc: 1, is_basic: false, is_preferred: true }).tier).toBe(
      "preferred",
    );
    expect(normalizeComponent({ lcsc: 1 }).tier).toBe("extended");
  });

  it("fills safe defaults for missing fields", () => {
    const part = normalizeComponent({ lcsc: 5 });
    expect(part).toMatchObject({
      lcsc: "C5",
      lcscId: 5,
      mfr: "",
      description: "",
      package: "",
      stock: 0,
      tier: "extended",
      priceBreaks: [],
      unitPrice: null,
      productUrl: "https://jlcpcb.com/partdetail/C5",
    });
    expect(part.attributes).toBeUndefined();
  });

  it("coerces bad stock values to 0", () => {
    expect(normalizeComponent({ lcsc: 5, stock: -3 }).stock).toBe(0);
    expect(normalizeComponent({ lcsc: 5, stock: "junk" }).stock).toBe(0);
  });

  it("throws on rows that are not objects or lack lcsc", () => {
    expect(() => normalizeComponent(null)).toThrow();
    expect(() => normalizeComponent("x")).toThrow();
    expect(() => normalizeComponent([])).toThrow();
    expect(() => normalizeComponent({ mfr: "no lcsc" })).toThrow(/lcsc/);
    expect(() => normalizeComponent({ lcsc: "garbage" })).toThrow(/Invalid LCSC/);
  });
});

describe("normalizeResistor", () => {
  it("normalizes a real /resistors/list.json row with attributes and price1", () => {
    const part = normalizeResistor(fixture("resistors-10k-0603.json").resistors[0]);
    expect(part.lcsc).toBe("C25804");
    expect(part.tier).toBe("basic");
    expect(part.package).toBe("0603");
    expect(part.unitPrice).toBeCloseTo(0.000842857);
    expect(part.priceBreaks).toEqual([{ qFrom: 1, qTo: null, price: 0.000842857 }]);
    expect(part.attributes?.Resistance).toBe("10kΩ");
    expect(part.attributes?.Tolerance).toBe("±1%");
  });

  it("synthesizes a description from attributes when the API returns an empty one", () => {
    const part = normalizeResistor(fixture("resistors-10k-0603.json").resistors[0]);
    expect(part.description).toContain("10kΩ");
    expect(part.description).toContain("±1%");
    expect(part.description).toContain("0603");
  });

  it("keeps a non-empty API description verbatim", () => {
    const raw = { ...fixture("resistors-10k-0603.json").resistors[0], description: "orig" };
    expect(normalizeResistor(raw).description).toBe("orig");
  });
});

describe("normalizeCapacitor", () => {
  it("normalizes a real /capacitors/list.json row", () => {
    const part = normalizeCapacitor(fixture("capacitors-100nf-0603.json").capacitors[0]);
    expect(part.lcsc).toBe("C14663");
    expect(part.tier).toBe("basic");
    expect(part.attributes?.Capacitance).toBe("100nF");
    expect(part.attributes?.["Voltage Rated"]).toBe("50V");
    expect(part.description).toContain("100nF");
    expect(part.unitPrice).toBeCloseTo(0.002214286);
  });

  it("survives unparseable attributes strings", () => {
    const part = normalizeCapacitor({ lcsc: 42, attributes: "{broken json" });
    expect(part.attributes).toBeUndefined();
    expect(part.description).toBe("");
  });
});
