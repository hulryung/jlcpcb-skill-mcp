import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JlcDbClient } from "../../src/jlc/db.js";
import { HybridJlcClient } from "../../src/jlc/hybrid.js";
import type { JlcClient } from "../../src/jlc/client.js";
import type { Part } from "../../src/types.js";

function buildFixture(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE VIRTUAL TABLE parts USING fts5(
    'LCSC Part','First Category','Second Category','MFR.Part','Package',
    'Solder Joint' unindexed,'Manufacturer','Library Type','Description',
    'Datasheet' unindexed,'Price' unindexed,'Stock' unindexed,
    tokenize="trigram")`);
  db.prepare(`INSERT INTO parts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "C25804", "Resistors", "Chip Resistor - Surface Mount", "0603WAF1002T5E", "0603", 0,
    "UNI-ROYAL", "Basic", "-55℃~+155℃ 100mW 10kΩ 75V Thick Film Resistor ±1%",
    "http://d/25804", "1-:0.003", "335073",
  );
  db.close();
}

const livePart: Part = {
  lcsc: "C25804",
  lcscId: 25804,
  mfr: "0603WAF1002T5E",
  description: "live",
  package: "0603",
  stock: 999999,
  tier: "basic",
  priceBreaks: [{ qFrom: 1, qTo: null, price: 0.001 }],
  unitPrice: 0.001,
  productUrl: "https://jlcpcb.com/partdetail/C25804",
};

function stubApi(over: Partial<JlcClient>): JlcClient {
  return {
    searchComponents: vi.fn(),
    searchResistors: vi.fn(),
    searchCapacitors: vi.fn(),
    getPart: vi.fn(),
    getPassiveDetail: vi.fn(),
    listCategories: vi.fn(),
    ...over,
  } as unknown as JlcClient;
}

let dir: string;
let db: JlcDbClient;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jlchybrid-"));
  const p = join(dir, "parts.db");
  buildFixture(p);
  db = new JlcDbClient({ dbPath: p });
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("HybridJlcClient.getPart", () => {
  it("uses the live API first when it succeeds (fresh stock/tier)", async () => {
    const api = stubApi({ getPart: vi.fn().mockResolvedValue(livePart) });
    const hybrid = new HybridJlcClient(db, api);
    const p = await hybrid.getPart("C25804");
    expect(p?.stock).toBe(999999); // live value, not the DB snapshot 335073
    expect(p?.attributes?.["Data Source"]).toBeUndefined();
    expect(api.getPart).toHaveBeenCalledOnce();
  });

  it("falls back to the local DB when the API throws, marking the snapshot", async () => {
    const api = stubApi({ getPart: vi.fn().mockRejectedValue(new Error("network down")) });
    const hybrid = new HybridJlcClient(db, api);
    const p = await hybrid.getPart("C25804");
    expect(p?.lcsc).toBe("C25804");
    expect(p?.stock).toBe(335073); // DB snapshot
    expect(p?.attributes?.["Data Source"]).toMatch(/local-db/);
  });

  it("falls back to the local DB when the API returns null", async () => {
    const api = stubApi({ getPart: vi.fn().mockResolvedValue(null) });
    const hybrid = new HybridJlcClient(db, api);
    const p = await hybrid.getPart("C25804");
    expect(p?.stock).toBe(335073);
    expect(p?.attributes?.["Data Source"]).toMatch(/local-db/);
  });
});

describe("HybridJlcClient search/list", () => {
  it("delegates search to the local DB (does not touch the API)", async () => {
    const api = stubApi({});
    const hybrid = new HybridJlcClient(db, api);
    const rs = await hybrid.searchResistors({ ohms: 10000, package: "0603", limit: 5 });
    expect(rs.map((p) => p.lcsc)).toContain("C25804");
    expect(api.searchResistors).not.toHaveBeenCalled();
  });
});
