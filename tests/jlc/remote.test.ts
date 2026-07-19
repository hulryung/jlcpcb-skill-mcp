import { describe, expect, it, vi } from "vitest";
import { JlcRemoteClient } from "../../src/jlc/remote.js";
import type { Part } from "../../src/types.js";

const part: Part = {
  lcsc: "C25804",
  lcscId: 25804,
  mfr: "0603WAF1002T5E",
  description: "10kΩ",
  package: "0603",
  stock: 335073,
  tier: "basic",
  priceBreaks: [{ qFrom: 1, qTo: null, price: 0.003 }],
  unitPrice: 0.003,
  productUrl: "https://jlcpcb.com/partdetail/C25804",
};

function stubFetch(handler: (url: string) => unknown): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    return new Response(JSON.stringify(handler(url)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("JlcRemoteClient", () => {
  it("builds the search query string and returns Part[]", async () => {
    let seen = "";
    const c = new JlcRemoteClient({
      baseUrl: "https://api.example.com/",
      fetchFn: stubFetch((url) => {
        seen = url;
        return [part];
      }),
    });
    const rs = await c.searchComponents({ q: "10k", package: "0603", minStock: 100, limit: 5 });
    expect(rs[0].lcsc).toBe("C25804");
    expect(seen).toContain("/search?");
    expect(seen).toContain("q=10k");
    expect(seen).toContain("package=0603");
    expect(seen).toContain("min_stock=100");
    expect(seen).not.toContain("//search"); // trailing slash trimmed
  });

  it("maps resistor options to /resistors", async () => {
    let seen = "";
    const c = new JlcRemoteClient({
      baseUrl: "https://api.example.com",
      fetchFn: stubFetch((url) => {
        seen = url;
        return [part];
      }),
    });
    await c.searchResistors({ ohms: 10000, package: "0603", maxTolerance: 0.01, limit: 3 });
    expect(seen).toContain("/resistors?");
    expect(seen).toContain("ohms=10000");
    expect(seen).toContain("max_tolerance=0.01");
  });

  it("normalizes the lcsc for get_part", async () => {
    let seen = "";
    const c = new JlcRemoteClient({
      baseUrl: "https://api.example.com",
      fetchFn: stubFetch((url) => {
        seen = url;
        return part;
      }),
    });
    const p1 = await c.getPart("C25804");
    const p2 = await c.getPart(25804);
    expect(p1?.lcsc).toBe("C25804");
    expect(p2?.lcsc).toBe("C25804");
    expect(seen).toContain("/part/C25804");
  });

  it("throws a descriptive error on a non-OK response", async () => {
    const c = new JlcRemoteClient({
      baseUrl: "https://api.example.com",
      fetchFn: vi.fn(async () => new Response("nope", { status: 502 })) as unknown as typeof fetch,
    });
    await expect(c.searchComponents({ q: "x" })).rejects.toThrow(/502/);
  });
});
