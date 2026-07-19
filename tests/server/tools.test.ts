import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, type JlcClientLike } from "../../src/server.js";
import type {
  CapacitorSearchOptions,
  Part,
  ResistorSearchOptions,
  SearchOptions,
} from "../../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

function makePart(overrides: Partial<Part> = {}): Part {
  const lcscId = overrides.lcscId ?? 25804;
  return {
    lcsc: `C${lcscId}`,
    lcscId,
    mfr: "0603WAF1002T5E",
    description: "Thick Film Resistors 10kOhm ±1% 100mW 0603",
    package: "0603",
    category: "Resistors",
    subcategory: "Chip Resistor - Surface Mount",
    stock: 37_000_000,
    tier: "basic",
    priceBreaks: [{ qFrom: 1, qTo: null, price: 0.0011 }],
    unitPrice: 0.0011,
    attributes: { Resistance: "10kΩ", Tolerance: "±1%" },
    productUrl: `https://jlcpcb.com/partdetail/C${lcscId}`,
    ...overrides,
  };
}

class StubClient implements JlcClientLike {
  searchComponentsCalls: SearchOptions[] = [];
  searchResistorsCalls: ResistorSearchOptions[] = [];
  searchCapacitorsCalls: CapacitorSearchOptions[] = [];
  getPartCalls: Array<string | number> = [];
  getPassiveDetailCalls: Array<{ lcsc: string | number; kind: "resistor" | "capacitor" }> = [];

  searchComponentsResult: Part[] = [];
  searchResistorsResult: Part[] = [];
  searchCapacitorsResult: Part[] = [];
  partsById = new Map<number, Part>();
  /** Spec-bearing Parts served by getPassiveDetail (getPart never has attributes). */
  passiveDetailById = new Map<number, Part>();
  failWith: Error | null = null;

  addPart(part: Part): Part {
    this.partsById.set(part.lcscId, part);
    return part;
  }

  addPassiveDetail(part: Part): Part {
    this.passiveDetailById.set(part.lcscId, part);
    return part;
  }

  async searchComponents(opts: SearchOptions): Promise<Part[]> {
    if (this.failWith) throw this.failWith;
    this.searchComponentsCalls.push(opts);
    return this.searchComponentsResult;
  }

  async searchResistors(opts: ResistorSearchOptions): Promise<Part[]> {
    if (this.failWith) throw this.failWith;
    this.searchResistorsCalls.push(opts);
    return this.searchResistorsResult;
  }

  async searchCapacitors(opts: CapacitorSearchOptions): Promise<Part[]> {
    if (this.failWith) throw this.failWith;
    this.searchCapacitorsCalls.push(opts);
    return this.searchCapacitorsResult;
  }

  /** Mimics normalize.ts toLcscId: throws on malformed LCSC numbers ("abc"). */
  private toId(lcsc: string | number): number {
    if (typeof lcsc === "number") return lcsc;
    const m = /^[Cc]?(\d+)$/.exec(String(lcsc).trim());
    if (!m) throw new Error(`Invalid LCSC number: ${JSON.stringify(lcsc)}`);
    return Number(m[1]);
  }

  async getPart(lcsc: string | number): Promise<Part | null> {
    if (this.failWith) throw this.failWith;
    this.getPartCalls.push(lcsc);
    return this.partsById.get(this.toId(lcsc)) ?? null;
  }

  async getPassiveDetail(
    lcsc: string | number,
    kind: "resistor" | "capacitor"
  ): Promise<Part | null> {
    if (this.failWith) throw this.failWith;
    this.getPassiveDetailCalls.push({ lcsc, kind });
    return this.passiveDetailById.get(this.toId(lcsc)) ?? null;
  }

  async listCategories(): Promise<{ category: string; subcategory: string }[]> {
    return [];
  }
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function setup(stub: JlcClientLike): Promise<Client> {
  const server = buildServer({ client: stub });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

interface ToolResponse {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResponse> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResponse;
}

/** Every successful tool result must be one text block: summary + fenced JSON. */
function splitResult(res: ToolResponse): { summary: string; data: any } {
  expect(res.isError ?? false).toBe(false);
  expect(res.content).toHaveLength(1);
  expect(res.content[0].type).toBe("text");
  const text = res.content[0].text;
  const m = text.match(/^([\s\S]+?)\n\n```json\n([\s\S]+)\n```\s*$/);
  expect(m, `expected summary + fenced json, got:\n${text}`).toBeTruthy();
  const summary = m![1];
  expect(summary).not.toContain("\n");
  return { summary, data: JSON.parse(m![2]) };
}

function expectError(res: ToolResponse, pattern: RegExp): void {
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toMatch(pattern);
}

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "jlcpcb-mcp-test-"));
  cleanups.push(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("buildServer", () => {
  it("registers exactly the 7 contract tools", async () => {
    const client = await setup(new StubClient());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "analyze_kicad",
      "estimate_assembly_cost",
      "find_alternatives",
      "get_part",
      "search_parts",
      "search_passives",
      "suggest_bom_parts",
    ]);
    for (const tool of tools) {
      expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
    }
  });

  it("documents search_parts tier as an admit-lower filter, not an exact-tier restriction (M4)", async () => {
    const client = await setup(new StubClient());
    const { tools } = await client.listTools();
    const searchParts = tools.find((t) => t.name === "search_parts")!;
    const tierDesc = (searchParts.inputSchema as any).properties.tier.description as string;
    expect(tierDesc).toBeTruthy();
    expect(tierDesc).not.toMatch(/restrict to one/i);
    // basic/preferred → fee-free parts only; extended → no filtering at all
    expect(tierDesc).toMatch(/fee-free/i);
    expect(tierDesc).toMatch(/no filtering/i);
    expect(tierDesc).toMatch(/tier field/i);
  });

  it("documents that analyze_kicad follows hierarchical sheets automatically (M6)", async () => {
    const client = await setup(new StubClient());
    const { tools } = await client.listTools();
    const analyze = tools.find((t) => t.name === "analyze_kicad")!;
    expect(analyze.description).toMatch(/hierarchical sheets are followed automatically/i);
  });
});

// ---------------------------------------------------------------------------
// search_parts
// ---------------------------------------------------------------------------

describe("search_parts", () => {
  it("returns summary line + JSON parts list", async () => {
    const stub = new StubClient();
    stub.searchComponentsResult = [makePart(), makePart({ lcscId: 17414 })];
    const client = await setup(stub);

    const res = await callTool(client, "search_parts", { query: "10k 0603" });
    const { summary, data } = splitResult(res);

    expect(summary).toBe("2 parts found for '10k 0603' — top: C25804 (basic, 37M stock)");
    expect(data.query).toBe("10k 0603");
    expect(data.parts).toHaveLength(2);
    expect(data.parts[0]).toMatchObject({
      lcsc: "C25804",
      mfr: "0603WAF1002T5E",
      package: "0603",
      tier: "basic",
      stock: 37_000_000,
      unitPrice: 0.0011,
    });
  });

  it("maps input fields to SearchOptions and clamps limit to 50", async () => {
    const stub = new StubClient();
    const client = await setup(stub);

    await callTool(client, "search_parts", {
      query: "led",
      package: "0603",
      tier: "basic",
      min_stock: 1000,
      limit: 500,
    });

    expect(stub.searchComponentsCalls).toHaveLength(1);
    expect(stub.searchComponentsCalls[0]).toEqual({
      q: "led",
      package: "0603",
      tier: "basic",
      minStock: 1000,
      limit: 50,
    });
  });

  it("defaults limit to 10 and clamps low limits to 1", async () => {
    const stub = new StubClient();
    const client = await setup(stub);
    await callTool(client, "search_parts", { query: "x" });
    await callTool(client, "search_parts", { query: "x", limit: 0 });
    expect(stub.searchComponentsCalls[0].limit).toBe(10);
    expect(stub.searchComponentsCalls[1].limit).toBe(1);
  });

  it("handles zero results without error", async () => {
    const client = await setup(new StubClient());
    const res = await callTool(client, "search_parts", { query: "unobtainium" });
    const { summary, data } = splitResult(res);
    expect(summary).toMatch(/^0 parts found for 'unobtainium'/);
    expect(data.parts).toEqual([]);
  });

  it("reports client failures as isError", async () => {
    const stub = new StubClient();
    stub.failWith = new Error("network down");
    const client = await setup(stub);
    const res = await callTool(client, "search_parts", { query: "x" });
    expectError(res, /search_parts failed: network down/);
  });
});

// ---------------------------------------------------------------------------
// search_passives (uses real kicad parseValue)
// ---------------------------------------------------------------------------

describe("search_passives", () => {
  it("parses resistor values into ohms and calls searchResistors", async () => {
    const stub = new StubClient();
    stub.searchResistorsResult = [makePart()];
    const client = await setup(stub);

    const res = await callTool(client, "search_passives", {
      kind: "resistor",
      value: "10k",
      package: "0603",
    });
    const { summary, data } = splitResult(res);

    expect(stub.searchResistorsCalls).toHaveLength(1);
    expect(stub.searchResistorsCalls[0].ohms).toBe(10_000);
    expect(stub.searchResistorsCalls[0].package).toBe("0603");
    expect(summary).toContain("1 resistor found for '10k' (10kΩ, 0603)");
    expect(summary).toContain("top: C25804 (basic, 37M stock)");
    expect(data.parts[0].lcsc).toBe("C25804");
    expect(data.parsed.ohms).toBe(10_000);
  });

  it("parses 4k7-style values", async () => {
    const stub = new StubClient();
    const client = await setup(stub);
    await callTool(client, "search_passives", { kind: "resistor", value: "4k7" });
    expect(stub.searchResistorsCalls[0].ohms).toBeCloseTo(4700, 6);
  });

  it("parses capacitor values into farads and calls searchCapacitors", async () => {
    const stub = new StubClient();
    stub.searchCapacitorsResult = [
      makePart({
        lcscId: 14663,
        mfr: "CL10B104KB8NNNC",
        description: "MLCC 100nF ±10% 50V X7R 0603",
        attributes: { Capacitance: "100nF" },
      }),
    ];
    const client = await setup(stub);

    const res = await callTool(client, "search_passives", { kind: "capacitor", value: "100nF" });
    const { data } = splitResult(res);

    expect(stub.searchCapacitorsCalls).toHaveLength(1);
    expect(stub.searchCapacitorsCalls[0].farads).toBeCloseTo(100e-9, 12);
    expect(data.parts[0].lcsc).toBe("C14663");
  });

  it("rejects unparseable values with a friendly error", async () => {
    const stub = new StubClient();
    const client = await setup(stub);
    const res = await callTool(client, "search_passives", { kind: "resistor", value: "hello" });
    expectError(res, /Could not parse "hello"/);
    expect(stub.searchResistorsCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// get_part
// ---------------------------------------------------------------------------

describe("get_part", () => {
  it("returns full detail including price breaks and attributes", async () => {
    const stub = new StubClient();
    stub.addPart(
      makePart({
        priceBreaks: [
          { qFrom: 1, qTo: 99, price: 0.0025 },
          { qFrom: 100, qTo: null, price: 0.0011 },
        ],
        unitPrice: 0.0025,
      })
    );
    const client = await setup(stub);

    const res = await callTool(client, "get_part", { lcsc: "C25804" });
    const { summary, data } = splitResult(res);

    expect(summary).toMatch(/^C25804 — 0603WAF1002T5E \[0603\] \(basic, 37M stock, \$0\.0025 @ qty 1\)/);
    expect(data.lcsc).toBe("C25804");
    expect(data.priceBreaks).toHaveLength(2);
    expect(data.priceBreaks[1]).toEqual({ qFrom: 100, qTo: null, price: 0.0011 });
    expect(data.attributes.Resistance).toBe("10kΩ");
    expect(data.productUrl).toBe("https://jlcpcb.com/partdetail/C25804");
  });

  it("errors when the part does not exist", async () => {
    const client = await setup(new StubClient());
    const res = await callTool(client, "get_part", { lcsc: "C99999999" });
    expectError(res, /C99999999.*not found/);
  });
});

// ---------------------------------------------------------------------------
// find_alternatives (uses real engine rankCandidates)
// ---------------------------------------------------------------------------

describe("find_alternatives", () => {
  it("finds resistor alternatives parametrically and excludes the part itself", async () => {
    const stub = new StubClient();
    const target = stub.addPart(makePart());
    const alt1 = makePart({ lcscId: 100001, mfr: "RC0603FR-0710KL", stock: 5_000_000 });
    const alt2 = makePart({
      lcscId: 100002,
      mfr: "AC0603FR-0710KL",
      tier: "extended",
      stock: 200_000,
    });
    stub.searchResistorsResult = [target, alt1, alt2];
    const client = await setup(stub);

    const res = await callTool(client, "find_alternatives", { lcsc: "C25804" });
    const { summary, data } = splitResult(res);

    // Parametric path: resistance attribute drove a searchResistors call.
    expect(stub.searchResistorsCalls).toHaveLength(1);
    expect(stub.searchResistorsCalls[0].ohms).toBeCloseTo(10_000, 3);

    expect(data.target.lcsc).toBe("C25804");
    const lcscs = data.alternatives.map((a: any) => a.lcsc);
    expect(lcscs).not.toContain("C25804");
    expect(lcscs).toContain("C100001");
    expect(summary).toMatch(/alternatives? found for C25804/);
    for (const alt of data.alternatives) {
      expect(Array.isArray(alt.reasons)).toBe(true);
      expect(Array.isArray(alt.warnings)).toBe(true);
      expect(typeof alt.score).toBe("number");
    }
  });

  it("falls back to text search by mfr for non-passives", async () => {
    const stub = new StubClient();
    const target = stub.addPart(
      makePart({
        lcscId: 6186,
        mfr: "AMS1117-3.3",
        description: "Low Dropout Regulator LDO 3.3V 1A SOT-223",
        package: "SOT-223",
        category: "Power Management ICs",
        subcategory: "Voltage Regulators - Linear, Low Drop Out (LDO) Regulators",
        attributes: {},
      })
    );
    const clone = makePart({
      lcscId: 173386,
      mfr: "AMS1117-3.3 CLONE",
      description: "LDO 3.3V 1A SOT-223",
      package: "SOT-223",
      category: "Power Management ICs",
      attributes: {},
    });
    stub.searchComponentsResult = [target, clone];
    const client = await setup(stub);

    const res = await callTool(client, "find_alternatives", { lcsc: "C6186", limit: 3 });
    const { data } = splitResult(res);

    expect(stub.searchComponentsCalls).toHaveLength(1);
    expect(stub.searchComponentsCalls[0].q).toBe("AMS1117-3.3");
    const lcscs = data.alternatives.map((a: any) => a.lcsc);
    expect(lcscs).not.toContain("C6186");
  });

  it("excludes wrong-class parts from a fuzzy connector search", async () => {
    const stub = new StubClient();
    const usbc = stub.addPart(
      makePart({
        lcscId: 165948,
        mfr: "TYPE-C-31-M-12",
        description: "16P USB-C receptacle SMD",
        package: "SMD",
        category: "Connectors",
        subcategory: "USB Connectors",
        tier: "extended",
        attributes: {},
      })
    );
    const otherConnector = makePart({
      lcscId: 456789,
      mfr: "TYPE-C-31-M-14",
      description: "16P USB-C receptacle SMD",
      package: "SMD",
      category: "Connectors",
      subcategory: "USB Connectors",
      tier: "extended",
      attributes: {},
    });
    // A fuzzy MPN search returns an unrelated inductor (package "SMD,6x6mm"
    // prefix-matches the connector's generic "SMD") — it must be filtered out.
    const inductor = makePart({
      lcscId: 57254,
      mfr: "SWPA6045S6R8MT",
      description: "6.8uH Power Inductor SMD",
      package: "SMD,6x6mm",
      category: "Inductors/Coils/Transformers",
      subcategory: "Power Inductors",
      tier: "extended",
      attributes: {},
    });
    stub.searchComponentsResult = [usbc, otherConnector, inductor];
    const client = await setup(stub);

    const res = await callTool(client, "find_alternatives", { lcsc: "C165948" });
    const { data } = splitResult(res);
    const lcscs = data.alternatives.map((a: any) => a.lcsc);
    expect(lcscs).toContain("C456789"); // the other USB-C connector
    expect(lcscs).not.toContain("C57254"); // the inductor is dropped
    expect(lcscs).not.toContain("C165948"); // never the part itself
  });

  it("errors for an unknown LCSC number", async () => {
    const client = await setup(new StubClient());
    const res = await callTool(client, "find_alternatives", { lcsc: "C424242" });
    expectError(res, /C424242.*not found/);
  });

  it("fetches passive specs via getPassiveDetail when getPart carries no attributes (M1)", async () => {
    const stub = new StubClient();
    // The real getPart never populates Part.attributes — specs only come from
    // the parametric category endpoint (getPassiveDetail).
    stub.addPart(makePart({ attributes: undefined }));
    stub.addPassiveDetail(makePart()); // same part WITH Resistance/Tolerance attributes
    stub.searchResistorsResult = [
      makePart({ lcscId: 100001, mfr: "RC0603FR-0710KL", stock: 5_000_000 }),
    ];
    const client = await setup(stub);

    const res = await callTool(client, "find_alternatives", { lcsc: "C25804" });
    const { data } = splitResult(res);

    expect(stub.getPassiveDetailCalls).toEqual([{ lcsc: "C25804", kind: "resistor" }]);
    expect(stub.searchResistorsCalls).toHaveLength(1); // parametric, not text search
    expect(stub.searchResistorsCalls[0].ohms).toBeCloseTo(10_000, 3);
    expect(data.alternatives.map((a: any) => a.lcsc)).toContain("C100001");
  });

  it("falls back to the target's own attribute probe when getPassiveDetail is null (M1)", async () => {
    const stub = new StubClient();
    stub.addPart(makePart()); // attributes present on the getPart result
    // nothing registered in passiveDetailById → getPassiveDetail returns null
    stub.searchResistorsResult = [
      makePart({ lcscId: 100001, mfr: "RC0603FR-0710KL", stock: 5_000_000 }),
    ];
    const client = await setup(stub);

    const res = await callTool(client, "find_alternatives", { lcsc: "C25804" });
    const { data } = splitResult(res);

    expect(stub.getPassiveDetailCalls).toHaveLength(1);
    expect(stub.searchResistorsCalls).toHaveLength(1); // still parametric via fallback
    expect(stub.searchResistorsCalls[0].ohms).toBeCloseTo(10_000, 3);
    expect(data.alternatives.map((a: any) => a.lcsc)).toContain("C100001");
  });

  it("does not pre-filter non-passive packages through the client's exact matcher (M2)", async () => {
    const stub = new StubClient();
    stub.addPart(
      makePart({
        lcscId: 7593,
        mfr: "NE555DR",
        description: "Timers 555 timer IC 4.5V-16V SOIC-8",
        package: "SOIC-8",
        category: "Timers/Clock ICs",
        subcategory: "Timers",
        attributes: undefined,
      })
    );
    // Variant package that an exact client filter would drop but the engine's
    // prefix-tolerant matcher keeps and flags.
    stub.searchComponentsResult = [
      makePart({
        lcscId: 7594,
        mfr: "SA555DR",
        description: "Timers 555 timer IC 4.5V-16V SOIC-8-EP",
        package: "SOIC-8-EP",
        category: "Timers/Clock ICs",
        subcategory: "Timers",
        attributes: undefined,
      }),
    ];
    const client = await setup(stub);

    const res = await callTool(client, "find_alternatives", { lcsc: "C7593" });
    const { data } = splitResult(res);

    expect(stub.searchComponentsCalls).toHaveLength(1);
    expect(stub.searchComponentsCalls[0].package).toBeUndefined();
    const variant = data.alternatives.find((a: any) => a.lcsc === "C7594");
    expect(variant).toBeTruthy();
    expect(variant.warnings.join(" ")).toMatch(/prefix match|verify footprint/i);
  });
});

// ---------------------------------------------------------------------------
// analyze_kicad (uses real kicad CSV parser)
// ---------------------------------------------------------------------------

const BOM_CSV = `Reference,Value,Footprint
R1,10k,Resistor_SMD:R_0603_1608Metric
R2,10k,Resistor_SMD:R_0603_1608Metric
C1,100nF,Capacitor_SMD:C_0603_1608Metric
`;

describe("analyze_kicad", () => {
  it("parses a BOM CSV and groups lines", async () => {
    const dir = await makeTmpDir();
    const csvPath = path.join(dir, "bom.csv");
    await writeFile(csvPath, BOM_CSV, "utf8");
    const client = await setup(new StubClient());

    const res = await callTool(client, "analyze_kicad", { path: csvPath });
    const { summary, data } = splitResult(res);

    expect(summary).toMatch(/^2 BOM lines \(3 components\) from bom\.csv/);
    expect(data.componentCount).toBe(3);
    expect(data.lines).toHaveLength(2);

    const rLine = data.lines.find((l: any) => l.references.includes("R1"));
    expect(rLine).toBeTruthy();
    expect(rLine.references).toEqual(["R1", "R2"]);
    expect(rLine.qtyPerBoard).toBe(2);
    expect(rLine.package).toBe("0603");
    expect(rLine.class).toBe("resistor");

    const cLine = data.lines.find((l: any) => l.references.includes("C1"));
    expect(cLine.qtyPerBoard).toBe(1);
    expect(cLine.class).toBe("capacitor");
  });

  it("errors for a missing file", async () => {
    const client = await setup(new StubClient());
    const res = await callTool(client, "analyze_kicad", { path: "/nonexistent/place/bom.csv" });
    expectError(res, /File not found: .*bom\.csv/);
  });

  it("errors for an unsupported extension", async () => {
    const dir = await makeTmpDir();
    const txtPath = path.join(dir, "notes.txt");
    await writeFile(txtPath, "not a bom", "utf8");
    const client = await setup(new StubClient());
    const res = await callTool(client, "analyze_kicad", { path: txtPath });
    expectError(res, /Unsupported file type.*notes\.txt/);
  });
});

// ---------------------------------------------------------------------------
// suggest_bom_parts (uses real engine + kicad)
// ---------------------------------------------------------------------------

describe("suggest_bom_parts", () => {
  it("rejects both path and bom_lines", async () => {
    const client = await setup(new StubClient());
    const res = await callTool(client, "suggest_bom_parts", {
      path: "x.csv",
      bom_lines: [{ value: "10k" }],
    });
    expectError(res, /exactly one/i);
  });

  it("rejects neither path nor bom_lines", async () => {
    const client = await setup(new StubClient());
    const res = await callTool(client, "suggest_bom_parts", {});
    expectError(res, /exactly one/i);
  });

  it("suggests parts for inline bom_lines with cost breakdown", async () => {
    const stub = new StubClient();
    stub.searchResistorsResult = [makePart()];
    const client = await setup(stub);

    const res = await callTool(client, "suggest_bom_parts", {
      bom_lines: [{ value: "10k", package: "0603", qty: 2, class: "resistor" }],
      board_qty: 10,
    });
    const { summary, data } = splitResult(res);

    expect(summary).toMatch(/^1 BOM line for 10 boards:/);
    expect(summary).toMatch(/est\. \$/);

    expect(data.boardQty).toBe(10);
    expect(data.lines).toHaveLength(1);
    const line = data.lines[0];
    expect(line.line.qtyPerBoard).toBe(2);
    expect(line.line.class).toBe("resistor");
    expect(line.status).toBe("matched");
    expect(line.chosen.lcsc).toBe("C25804");
    expect(Array.isArray(line.chosen.reasons)).toBe(true);
    expect(line.chosen.unitPriceAtQty).not.toBeNull();

    // 20 resistors @ $0.0011
    expect(data.cost.boardQty).toBe(10);
    expect(data.cost.componentCostTotal).toBeCloseTo(0.022, 5);
    expect(data.cost.loadingFees).toBe(0);
    expect(data.cost.total).toBeCloseTo(0.022, 5);
  });

  it("suggests from a BOM CSV path and defaults board_qty to 10", async () => {
    const dir = await makeTmpDir();
    const csvPath = path.join(dir, "bom.csv");
    await writeFile(csvPath, BOM_CSV, "utf8");
    const stub = new StubClient();
    stub.searchResistorsResult = [makePart()];
    stub.searchCapacitorsResult = [
      makePart({
        lcscId: 14663,
        mfr: "CL10B104KB8NNNC",
        description: "MLCC 100nF ±10% 50V X7R 0603",
        attributes: { Capacitance: "100nF" },
      }),
    ];
    const client = await setup(stub);

    const res = await callTool(client, "suggest_bom_parts", { path: csvPath });
    const { data } = splitResult(res);

    expect(data.boardQty).toBe(10);
    expect(data.lines).toHaveLength(2);
    expect(data.file.endsWith("bom.csv")).toBe(true);
    expect(data.cost.total).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(data.notes)).toBe(true);
  });

  it("errors for a bad path", async () => {
    const client = await setup(new StubClient());
    const res = await callTool(client, "suggest_bom_parts", { path: "/nope/missing.kicad_sch" });
    expectError(res, /File not found/);
  });

  it("infers resistor class from a bare '10k' value and searches parametrically (M3)", async () => {
    const stub = new StubClient();
    stub.searchResistorsResult = [makePart()];
    const client = await setup(stub);

    const res = await callTool(client, "suggest_bom_parts", {
      bom_lines: [{ value: "10k", package: "0603" }], // no class given
    });
    const { data } = splitResult(res);

    expect(data.lines[0].line.class).toBe("resistor");
    expect(stub.searchResistorsCalls).toHaveLength(1); // parametric, not text
    expect(stub.searchResistorsCalls[0].ohms).toBe(10_000);
    expect(data.lines[0].status).toBe("matched");
    expect(data.lines[0].chosen.lcsc).toBe("C25804");
  });

  it("infers capacitor class from '100nF' (M3)", async () => {
    const stub = new StubClient();
    stub.searchCapacitorsResult = [
      makePart({
        lcscId: 14663,
        mfr: "CL10B104KB8NNNC",
        description: "MLCC 100nF ±10% 50V X7R 0603",
        attributes: { Capacitance: "100nF" },
      }),
    ];
    const client = await setup(stub);

    const res = await callTool(client, "suggest_bom_parts", {
      bom_lines: [{ value: "100nF" }],
    });
    const { data } = splitResult(res);

    expect(data.lines[0].line.class).toBe("capacitor");
    expect(stub.searchCapacitorsCalls).toHaveLength(1);
    expect(stub.searchCapacitorsCalls[0].farads).toBeCloseTo(100e-9, 12);
    expect(data.lines[0].status).toBe("matched");
  });

  it("keeps text values as 'other' and frequencies as 'crystal' (M3)", async () => {
    const stub = new StubClient();
    const client = await setup(stub);

    const res = await callTool(client, "suggest_bom_parts", {
      bom_lines: [{ value: "NE555" }, { value: "8MHz" }],
    });
    const { data } = splitResult(res);

    expect(data.lines[0].line.class).toBe("other");
    expect(data.lines[1].line.class).toBe("crystal");
    // neither triggers a parametric passive search
    expect(stub.searchResistorsCalls).toHaveLength(0);
    expect(stub.searchCapacitorsCalls).toHaveLength(0);
    expect(stub.searchComponentsCalls.some((c) => c.q === "NE555")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// estimate_assembly_cost (uses real engine estimateCost)
// ---------------------------------------------------------------------------

describe("estimate_assembly_cost", () => {
  it("sums component cost and $3 loading fees per unique extended part", async () => {
    const stub = new StubClient();
    stub.addPart(
      makePart({
        lcscId: 1000,
        tier: "basic",
        priceBreaks: [{ qFrom: 1, qTo: null, price: 0.01 }],
        unitPrice: 0.01,
      })
    );
    stub.addPart(
      makePart({
        lcscId: 2000,
        mfr: "ESP32-C3FH4",
        tier: "extended",
        priceBreaks: [{ qFrom: 1, qTo: null, price: 1.0 }],
        unitPrice: 1.0,
        stock: 5000,
      })
    );
    const client = await setup(stub);

    const res = await callTool(client, "estimate_assembly_cost", {
      parts: [
        { lcsc: "C1000", qty_per_board: 2 },
        { lcsc: "C2000", qty_per_board: 1 },
      ],
      board_qty: 10,
    });
    const { summary, data } = splitResult(res);

    // components: 0.01*20 + 1.00*10 = 10.20; fees: $3 × 1 extended
    expect(data.cost.componentCostTotal).toBeCloseTo(10.2, 5);
    expect(data.cost.loadingFees).toBe(3);
    expect(data.cost.total).toBeCloseTo(13.2, 5);
    expect(data.cost.perBoard).toBeCloseTo(1.32, 5);
    expect(data.cost.uniqueParts).toBe(2);
    expect(data.cost.basicCount).toBe(1);
    expect(data.cost.extendedCount).toBe(1);

    expect(summary).toMatch(/^Est\. \$13\.20 for 10 boards — components \$10\.20/);
    expect(summary).toContain("1 extended");

    expect(data.parts).toHaveLength(2);
    expect(data.parts[0]).toMatchObject({ lcsc: "C1000", needed: 20, lineCost: 0.2 });
    expect(data.parts[1].warnings).toContain("+$3 loading fee (extended)");
    expect(data.notFound).toEqual([]);
  });

  it("uses the price break matching the needed quantity", async () => {
    const stub = new StubClient();
    stub.addPart(
      makePart({
        lcscId: 3000,
        priceBreaks: [
          { qFrom: 1, qTo: 99, price: 0.02 },
          { qFrom: 100, qTo: null, price: 0.01 },
        ],
        unitPrice: 0.02,
      })
    );
    const client = await setup(stub);

    const res = await callTool(client, "estimate_assembly_cost", {
      parts: [{ lcsc: "C3000", qty_per_board: 2 }],
      board_qty: 100, // needed = 200 → $0.01 break
    });
    const { data } = splitResult(res);
    expect(data.parts[0].unitPriceAtQty).toBeCloseTo(0.01, 6);
    expect(data.cost.componentCostTotal).toBeCloseTo(2.0, 5);
  });

  it("warns about low stock", async () => {
    const stub = new StubClient();
    stub.addPart(makePart({ lcscId: 4000, stock: 5 }));
    const client = await setup(stub);
    const res = await callTool(client, "estimate_assembly_cost", {
      parts: [{ lcsc: "C4000", qty_per_board: 1 }],
      board_qty: 10,
    });
    const { data } = splitResult(res);
    expect(data.parts[0].warnings.join(" ")).toMatch(/stock 5 below needed 10/);
  });

  it("reports unknown parts in notFound but still costs the rest", async () => {
    const stub = new StubClient();
    stub.addPart(makePart({ lcscId: 1000, priceBreaks: [{ qFrom: 1, qTo: null, price: 0.01 }] }));
    const client = await setup(stub);
    const res = await callTool(client, "estimate_assembly_cost", {
      parts: [
        { lcsc: "C1000", qty_per_board: 1 },
        { lcsc: "C77777", qty_per_board: 1 },
      ],
      board_qty: 10,
    });
    const { summary, data } = splitResult(res);
    expect(data.notFound).toEqual(["C77777"]);
    expect(summary).toContain("NOT FOUND: C77777");
    expect(data.parts).toHaveLength(1);
  });

  it("errors when no parts are found at all", async () => {
    const client = await setup(new StubClient());
    const res = await callTool(client, "estimate_assembly_cost", {
      parts: [{ lcsc: "C123456789", qty_per_board: 1 }],
      board_qty: 5,
    });
    expectError(res, /None of the requested parts were found/);
  });

  it("skips malformed LCSC tokens and still costs the rest (M5)", async () => {
    const stub = new StubClient();
    stub.addPart(makePart()); // C25804 @ $0.0011
    const client = await setup(stub);

    const res = await callTool(client, "estimate_assembly_cost", {
      parts: [
        { lcsc: "abc", qty_per_board: 1 }, // getPart throws on this token
        { lcsc: "C25804", qty_per_board: 2 },
      ],
      board_qty: 10,
    });
    const { summary, data } = splitResult(res);

    expect(data.notFound).toEqual(["abc (invalid LCSC format)"]);
    expect(data.parts).toHaveLength(1);
    expect(data.parts[0].lcsc).toBe("C25804");
    expect(data.cost.componentCostTotal).toBeCloseTo(0.022, 5);
    expect(summary).toContain("NOT FOUND: abc (invalid LCSC format)");
  });

  it("is an error only when nothing resolves (M5)", async () => {
    const client = await setup(new StubClient());
    const res = await callTool(client, "estimate_assembly_cost", {
      parts: [{ lcsc: "abc", qty_per_board: 1 }],
      board_qty: 5,
    });
    expectError(res, /None of the requested parts were found: abc \(invalid LCSC format\)/);
  });
});

// ---------------------------------------------------------------------------
// hierarchical sheets (M6) — root .kicad_sch pulling in sub-sheet files
// ---------------------------------------------------------------------------

function schematic(body: string): string {
  return `(kicad_sch (version 20231120) (generator "eeschema")\n${body}\n)`;
}

function symbolNode(ref: string, value: string, footprint: string): string {
  return `(symbol (lib_id "Device:R") (in_bom yes) (on_board yes) (dnp no)
    (property "Reference" "${ref}")
    (property "Value" "${value}")
    (property "Footprint" "${footprint}"))`;
}

function sheetNode(name: string, file: string): string {
  return `(sheet (at 100 50) (size 20 10)
    (property "Sheetname" "${name}")
    (property "Sheetfile" "${file}"))`;
}

describe("hierarchical sheets (M6)", () => {
  it("analyze_kicad merges components from sub-sheets and reports it", async () => {
    const dir = await makeTmpDir();
    await writeFile(
      path.join(dir, "root.kicad_sch"),
      schematic(
        [
          symbolNode("R1", "10k", "Resistor_SMD:R_0603_1608Metric"),
          sheetNode("Power", "power.kicad_sch"),
          sheetNode("MCU", "mcu.kicad_sch"),
        ].join("\n")
      ),
      "utf8"
    );
    await writeFile(
      path.join(dir, "power.kicad_sch"),
      schematic(symbolNode("C1", "100nF", "Capacitor_SMD:C_0603_1608Metric")),
      "utf8"
    );
    await writeFile(
      path.join(dir, "mcu.kicad_sch"),
      schematic(symbolNode("R2", "10k", "Resistor_SMD:R_0603_1608Metric")),
      "utf8"
    );
    const client = await setup(new StubClient());

    const res = await callTool(client, "analyze_kicad", { path: path.join(dir, "root.kicad_sch") });
    const { summary, data } = splitResult(res);

    expect(data.componentCount).toBe(3);
    const rLine = data.lines.find((l: any) => l.value === "10k");
    expect(rLine.references.slice().sort()).toEqual(["R1", "R2"]);
    expect(rLine.qtyPerBoard).toBe(2);
    expect(data.lines.some((l: any) => l.value === "100nF")).toBe(true);
    expect(data.warnings).toContain("followed 2 hierarchical sheet(s)");
    expect(summary).toContain("followed 2 hierarchical sheet(s)");
  });

  it("warns (not errors) about a missing sheet file", async () => {
    const dir = await makeTmpDir();
    await writeFile(
      path.join(dir, "root.kicad_sch"),
      schematic(
        [
          symbolNode("R1", "10k", "Resistor_SMD:R_0603_1608Metric"),
          sheetNode("Power", "power.kicad_sch"),
        ].join("\n")
      ),
      "utf8"
    );
    const client = await setup(new StubClient());

    const res = await callTool(client, "analyze_kicad", { path: path.join(dir, "root.kicad_sch") });
    const { summary, data } = splitResult(res);

    expect(data.componentCount).toBe(1);
    expect(data.warnings).toContain("sheet file not found: power.kicad_sch — skipped");
    expect(summary).toContain("sheet file not found: power.kicad_sch — skipped");
  });

  it("terminates on include cycles (A includes B includes A)", async () => {
    const dir = await makeTmpDir();
    await writeFile(
      path.join(dir, "a.kicad_sch"),
      schematic(
        [
          symbolNode("R1", "10k", "Resistor_SMD:R_0603_1608Metric"),
          sheetNode("B", "b.kicad_sch"),
        ].join("\n")
      ),
      "utf8"
    );
    await writeFile(
      path.join(dir, "b.kicad_sch"),
      schematic(
        [
          symbolNode("C1", "100nF", "Capacitor_SMD:C_0603_1608Metric"),
          sheetNode("A", "a.kicad_sch"),
        ].join("\n")
      ),
      "utf8"
    );
    const client = await setup(new StubClient());

    const res = await callTool(client, "analyze_kicad", { path: path.join(dir, "a.kicad_sch") });
    const { data } = splitResult(res);

    expect(data.componentCount).toBe(2); // each file parsed exactly once
    expect(data.warnings).toContain("followed 1 hierarchical sheet(s)");
    expect(data.warnings).toContain("multi-instance sheets are counted once");
  });

  it("suggest_bom_parts surfaces sheet warnings in its text output", async () => {
    const dir = await makeTmpDir();
    await writeFile(
      path.join(dir, "root.kicad_sch"),
      schematic(
        [
          symbolNode("R1", "10k", "Resistor_SMD:R_0603_1608Metric"),
          sheetNode("Power", "power.kicad_sch"),
        ].join("\n")
      ),
      "utf8"
    );
    const stub = new StubClient();
    stub.searchResistorsResult = [makePart()];
    const client = await setup(stub);

    const res = await callTool(client, "suggest_bom_parts", {
      path: path.join(dir, "root.kicad_sch"),
    });
    const { summary, data } = splitResult(res);

    expect(data.notes).toContain("sheet file not found: power.kicad_sch — skipped");
    expect(summary).toContain("sheet file not found: power.kicad_sch — skipped");
  });
});
