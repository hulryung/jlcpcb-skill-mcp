import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JlcDbClient, openDbIfAvailable, parseDbPriceBreaks } from "../../src/jlc/db.js";

/** Build a tiny fixture that mirrors the real trigram FTS5 schema + columns. */
function buildFixture(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE VIRTUAL TABLE parts USING fts5(
    'LCSC Part','First Category','Second Category','MFR.Part','Package',
    'Solder Joint' unindexed,'Manufacturer','Library Type','Description',
    'Datasheet' unindexed,'Price' unindexed,'Stock' unindexed,
    tokenize="trigram")`);
  const ins = db.prepare(`INSERT INTO parts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const rows: [string, string, string, string, string, number, string, string, string, string, string, string][] = [
    ["C25804", "Resistors", "Chip Resistor - Surface Mount", "0603WAF1002T5E", "0603", 0, "UNI-ROYAL", "Basic", "-55℃~+155℃ 100mW 10kΩ 75V Thick Film Resistor ±1% ±100ppm/℃", "http://d/25804", "1-:0.003", "335073"],
    ["C111111", "Resistors", "Chip Resistor - Surface Mount", "0805WAF1002", "0805", 0, "UNI-ROYAL", "Basic", "-55℃~+155℃ 125mW 10kΩ 150V Thick Film Resistor ±1%", "http://d/111111", "1-:0.004", "100000"],
    ["C99001", "Resistors", "Chip Resistor - Surface Mount", "0603WGF1002", "0603", 0, "ExtendedCo", "Extended", "-55℃~+155℃ 100mW 10kΩ 75V Thick Film Resistor ±1%", "http://d/99001", "1-:0.001", "9000000"],
    ["C14663", "Capacitors", "Multilayer Ceramic Capacitors MLCC - SMD/SMT", "CC0603KRX7R9BB104", "0603", 0, "YAGEO", "Basic", "100nF 50V X7R ±10%", "http://d/14663", "1-1999:0.019,2000-:0.018", "67887231"],
    ["C7593", "Clock/Timing", "555 Timers / Counters", "NE555DR", "SOIC-8", 0, "Texas Instruments", "Extended", "0℃~+70℃ 10mA 4.5V~16V", "http://d/7593", "1-49:0.132,50-149:0.105,150-499:0.092,500-2499:0.081,2500-4999:0.077,5000-:0.074", "185367"],
    ["C2286", "Optoelectronics", "LED Indication - Discrete", "KT-0603R", "0603", 0, "KENTO", "Basic", "-40℃~+85℃ square LED 1.8V~2.4V 20mA Red", "http://d/2286", "1-:0.007", "6450125"],
    ["C000000", "Resistors", "Chip Resistor - Surface Mount", "0603ZERO", "0603", 0, "ZeroStock", "Extended", "100mW 10kΩ 75V ±1%", "http://d/0", "1-:0.002", "0"],
    ["C999999", "Resistors", "Chip Resistor - Surface Mount", "0603NOPRICE", "0603", 0, "NoPrice", "Extended", "100mW 22kΩ 75V ±1%", "http://d/none", "", "5000"],
    ["C2580400", "Resistors", "Chip Resistor - Surface Mount", "SUBSTRING-COLLIDE", "0402", 0, "Collide", "Extended", "1kΩ ±5%", "http://d/collide", "1-:0.001", "1000"],
  ];
  for (const r of rows) ins.run(...r);
  db.close();
}

let dir: string;
let dbPath: string;
let client: JlcDbClient;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jlcdb-"));
  dbPath = join(dir, "parts.db");
  buildFixture(dbPath);
  client = new JlcDbClient({ dbPath });
});

afterAll(() => {
  client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("parseDbPriceBreaks", () => {
  it("parses a single open tier", () => {
    expect(parseDbPriceBreaks("1-:0.003")).toEqual([{ qFrom: 1, qTo: null, price: 0.003 }]);
  });
  it("parses a two-tier price with an open last tier", () => {
    expect(parseDbPriceBreaks("1-1999:0.019,2000-:0.018")).toEqual([
      { qFrom: 1, qTo: 1999, price: 0.019 },
      { qFrom: 2000, qTo: null, price: 0.018 },
    ]);
  });
  it("parses a six-tier price", () => {
    const breaks = parseDbPriceBreaks(
      "1-49:0.132,50-149:0.105,150-499:0.092,500-2499:0.081,2500-4999:0.077,5000-:0.074",
    );
    expect(breaks).toHaveLength(6);
    expect(breaks[0]).toEqual({ qFrom: 1, qTo: 49, price: 0.132 });
    expect(breaks[5]).toEqual({ qFrom: 5000, qTo: null, price: 0.074 });
  });
  it("returns [] for the empty string", () => {
    expect(parseDbPriceBreaks("")).toEqual([]);
  });
});

describe("JlcDbClient.searchResistors", () => {
  it("finds the 10k 0603 basic part and puts it first (tier before stock)", async () => {
    const rs = await client.searchResistors({ ohms: 10000, package: "0603", limit: 5 });
    const lcscs = rs.map((p) => p.lcsc);
    expect(lcscs).toContain("C25804");
    // C99001 (extended) has far more stock but C25804 (basic) must rank first.
    expect(rs[0].lcsc).toBe("C25804");
    expect(rs[0].tier).toBe("basic");
  });
  it("excludes a same-value part in a different package", async () => {
    const rs = await client.searchResistors({ ohms: 10000, package: "0603", limit: 10 });
    expect(rs.map((p) => p.lcsc)).not.toContain("C111111"); // 0805
  });
  it("verifies the parsed resistance (no wrong-value rows)", async () => {
    const rs = await client.searchResistors({ ohms: 10000, package: "0603", limit: 10 });
    for (const p of rs) expect(p.attributes?.Resistance).toMatch(/10k/i);
  });
});

describe("JlcDbClient.searchComponents", () => {
  it("filters by package exactly", async () => {
    const rs = await client.searchComponents({ q: "NE555", package: "SOIC-8", limit: 5 });
    expect(rs.map((p) => p.lcsc)).toContain("C7593");
  });
  it("honors minStock", async () => {
    const rs = await client.searchComponents({ q: "10kΩ", minStock: 1, limit: 20 });
    expect(rs.map((p) => p.lcsc)).not.toContain("C000000"); // stock 0
  });
  it("tier=basic restricts to Basic parts", async () => {
    const rs = await client.searchComponents({ q: "10kΩ", package: "0603", tier: "basic", limit: 20 });
    expect(rs.length).toBeGreaterThan(0);
    for (const p of rs) expect(p.tier).toBe("basic");
  });
});

describe("JlcDbClient.getPart", () => {
  it("returns the exact LCSC, not a substring collision", async () => {
    const p = await client.getPart("C25804");
    expect(p?.lcsc).toBe("C25804");
    expect(p?.mfr).toBe("0603WAF1002T5E");
  });
  it("maps Basic→basic and Extended→extended", async () => {
    expect((await client.getPart("C25804"))?.tier).toBe("basic");
    expect((await client.getPart("C7593"))?.tier).toBe("extended");
  });
  it("parses tiered price breaks", async () => {
    const p = await client.getPart("C7593");
    expect(p?.priceBreaks).toHaveLength(6);
    expect(p?.unitPrice).toBe(0.132);
  });
  it("returns null for an unknown part", async () => {
    expect(await client.getPart("C40404040")).toBeNull();
  });
});

describe("JlcDbClient.getPassiveDetail", () => {
  it("returns a resistor for a resistor lcsc", async () => {
    const p = await client.getPassiveDetail("C25804", "resistor");
    expect(p?.lcsc).toBe("C25804");
  });
  it("does not return a capacitor when asked for a resistor", async () => {
    const p = await client.getPassiveDetail("C14663", "resistor");
    expect(p).toBeNull();
  });
});

describe("openDbIfAvailable", () => {
  it("returns null when the file is missing (never throws)", () => {
    expect(openDbIfAvailable(join(dir, "does-not-exist.db"))).toBeNull();
  });
  it("opens an existing DB", () => {
    const c = openDbIfAvailable(dbPath);
    expect(c).not.toBeNull();
    c?.close();
  });
});
