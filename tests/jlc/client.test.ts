import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JlcClient } from "../../src/jlc/client.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/jlc", import.meta.url));

function fixture(name: string): any {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Route = (url: URL) => Response | Promise<Response>;

/** fetch stub dispatching on pathname; records every requested URL. */
function makeFetch(routes: Record<string, Route>) {
  const calls: URL[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url);
    const route = routes[url.pathname];
    if (!route) throw new Error(`no fixture route for ${url.pathname}`);
    return route(url);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function client(routes: Record<string, Route>, timeoutMs?: number) {
  const { fetchFn, calls } = makeFetch(routes);
  return { client: new JlcClient({ fetchFn, timeoutMs }), calls, fetchFn };
}

const ne555Routes: Record<string, Route> = {
  "/api/search": () => jsonResponse(fixture("api-search-ne555.json")),
  "/components/list.json": () => jsonResponse(fixture("components-ne555.json")),
};

describe("JlcClient.searchComponents", () => {
  it("merges /api/search and /components/list.json rows, deduped by lcsc", async () => {
    const { client: c } = client(ne555Routes);
    const parts = await c.searchComponents({ q: "NE555" });
    // api fixture: 7593, 695838, 5125085, 18723595; components fixture: 7593,
    // 5125085, 18723595, 18164403 → 5 unique.
    expect(parts).toHaveLength(5);
    expect(new Set(parts.map((p) => p.lcscId))).toEqual(
      new Set([7593, 695838, 5125085, 18723595, 18164403]),
    );
  });

  it("prefers the richer row (price breaks + category) for duplicates", async () => {
    const { client: c } = client(ne555Routes);
    const parts = await c.searchComponents({ q: "NE555" });
    const ne555 = parts.find((p) => p.lcscId === 7593)!;
    expect(ne555.priceBreaks.length).toBe(6);
    expect(ne555.category).toBe("Clock and Timing");
    expect(ne555.tier).toBe("preferred");
    // api-only row keeps its single-price break
    const apiOnly = parts.find((p) => p.lcscId === 695838)!;
    expect(apiOnly.priceBreaks).toEqual([{ qFrom: 1, qTo: null, price: 0.048857143 }]);
    expect(apiOnly.category).toBeUndefined();
  });

  it("sorts by stock descending and applies limit after merge", async () => {
    const { client: c } = client(ne555Routes);
    const parts = await c.searchComponents({ q: "NE555", limit: 3 });
    expect(parts.map((p) => p.lcscId)).toEqual([7593, 695838, 5125085]);
    expect(parts[0].stock).toBeGreaterThanOrEqual(parts[1].stock);
  });

  it("queries both endpoints sequentially with the same q", async () => {
    const { client: c, calls } = client(ne555Routes);
    await c.searchComponents({ q: "NE555" });
    expect(calls.map((u) => u.pathname)).toEqual(["/api/search", "/components/list.json"]);
    expect(calls[0].searchParams.get("q")).toBe("NE555");
    expect(calls[0].searchParams.get("full")).toBe("true");
    expect(calls[1].searchParams.get("search")).toBe("NE555");
    expect(calls[1].searchParams.get("full")).toBe("true");
  });

  it("filters by minStock client-side", async () => {
    const { client: c } = client(ne555Routes);
    const parts = await c.searchComponents({ q: "NE555", minStock: 100_000 });
    expect(parts.map((p) => p.lcscId)).toEqual([7593, 695838]);
  });

  it("filters by tier: 'basic' admits preferred, 'extended' admits everything", async () => {
    const { client: c } = client(ne555Routes);
    const basicish = await c.searchComponents({ q: "NE555", tier: "basic" });
    expect(basicish.map((p) => p.lcscId)).toEqual([7593]); // only the preferred part
    const { client: c2 } = client(ne555Routes);
    const all = await c2.searchComponents({ q: "NE555", tier: "extended" });
    expect(all).toHaveLength(5);
  });

  it("passes package to both endpoints and also filters client-side", async () => {
    const { client: c, calls } = client(ne555Routes);
    const parts = await c.searchComponents({ q: "NE555", package: "SOIC-8" });
    expect(parts.map((p) => p.lcscId)).toEqual([7593]);
    const listCall = calls.find((u) => u.pathname === "/components/list.json")!;
    expect(listCall.searchParams.get("package")).toBe("SOIC-8");
    const apiCall = calls.find((u) => u.pathname === "/api/search")!;
    expect(apiCall.searchParams.get("package")).toBe("SOIC-8");
  });

  it("matches package case-insensitively", async () => {
    const { client: c } = client(ne555Routes);
    const parts = await c.searchComponents({ q: "NE555", package: "soic-8" });
    expect(parts.map((p) => p.lcscId)).toEqual([7593]);
  });

  // Regression (finding J1): the server matches package= case-sensitively, so
  // "soic-8" yields zero rows server-side. The client must retry without the
  // package param and let its case-insensitive filter do the matching.
  it("retries without package when the case-sensitive server filter drops every row", async () => {
    const zeroRowsWhenPackaged =
      (fixtureName: string): Route =>
      (url) =>
        url.searchParams.has("package")
          ? jsonResponse({ components: [] })
          : jsonResponse(fixture(fixtureName));
    const { client: c, calls } = client({
      "/api/search": zeroRowsWhenPackaged("api-search-ne555.json"),
      "/components/list.json": zeroRowsWhenPackaged("components-ne555.json"),
    });
    const parts = await c.searchComponents({ q: "NE555", package: "soic-8" });
    expect(parts.map((p) => p.lcscId)).toEqual([7593]);
    // The rich list.json row survived: price breaks + category intact.
    expect(parts[0].priceBreaks).toHaveLength(6);
    expect(parts[0].category).toBe("Clock and Timing");
    // Each endpoint: one package-filtered call, then one retry without it.
    const listCalls = calls.filter((u) => u.pathname === "/components/list.json");
    expect(listCalls.map((u) => u.searchParams.get("package"))).toEqual(["soic-8", null]);
    const apiCalls = calls.filter((u) => u.pathname === "/api/search");
    expect(apiCalls.map((u) => u.searchParams.get("package"))).toEqual(["soic-8", null]);
  });

  it("does not retry when the package-filtered calls return rows", async () => {
    const { client: c, calls } = client(ne555Routes);
    await c.searchComponents({ q: "NE555", package: "SOIC-8" });
    expect(calls.map((u) => u.pathname)).toEqual(["/api/search", "/components/list.json"]);
  });

  it("does not retry zero-row responses when no package filter was sent", async () => {
    const { client: c, calls } = client({
      "/api/search": () => jsonResponse({ components: [] }),
      "/components/list.json": () => jsonResponse({ components: [] }),
    });
    expect(await c.searchComponents({ q: "nothing-matches" })).toEqual([]);
    expect(calls.map((u) => u.pathname)).toEqual(["/api/search", "/components/list.json"]);
  });

  it("skips /api/search when q is empty and only lists components", async () => {
    const { client: c, calls } = client(ne555Routes);
    const parts = await c.searchComponents({ package: "SOIC-8" });
    expect(calls.map((u) => u.pathname)).toEqual(["/components/list.json"]);
    expect(parts.map((p) => p.lcscId)).toEqual([7593]);
  });

  it("ignores malformed rows instead of failing the whole search", async () => {
    const broken = fixture("components-ne555.json");
    broken.components.push({ mfr: "no lcsc field" }, null);
    const { client: c } = client({
      "/api/search": () => jsonResponse({ components: [] }),
      "/components/list.json": () => jsonResponse(broken),
    });
    const parts = await c.searchComponents({ q: "NE555" });
    expect(parts).toHaveLength(4);
  });

  it("throws a descriptive error on unexpected response shape", async () => {
    const { client: c } = client({
      "/api/search": () => jsonResponse({ nope: true }),
    });
    await expect(c.searchComponents({ q: "x" })).rejects.toThrow(/unexpected response shape/);
  });
});

describe("JlcClient.searchResistors", () => {
  const routes: Record<string, Route> = {
    "/resistors/list.json": () => jsonResponse(fixture("resistors-10k-0603.json")),
  };

  it("returns normalized parts sorted by stock desc", async () => {
    const { client: c, calls } = client(routes);
    const parts = await c.searchResistors({ ohms: 10_000, package: "0603" });
    expect(parts).toHaveLength(4);
    expect(parts[0].lcsc).toBe("C25804");
    expect(parts[0].tier).toBe("basic");
    expect(calls[0].searchParams.get("resistance")).toBe("10000");
    expect(calls[0].searchParams.get("package")).toBe("0603");
  });

  it("filters by maxTolerance client-side", async () => {
    const { client: c } = client(routes);
    const parts = await c.searchResistors({ ohms: 10_000, maxTolerance: 0.02 });
    // C2930027 is the 5% row in the fixture
    expect(parts.map((p) => p.lcscId)).not.toContain(2930027);
    expect(parts).toHaveLength(3);
  });

  it("drops rows whose resistance drifts from the requested ohms", async () => {
    const drifted = fixture("resistors-10k-0603.json");
    drifted.resistors[1].resistance = 22_000; // simulate server-side param drift
    const { client: c } = client({
      "/resistors/list.json": () => jsonResponse(drifted),
    });
    const parts = await c.searchResistors({ ohms: 10_000 });
    expect(parts.map((p) => p.lcscId)).not.toContain(drifted.resistors[1].lcsc);
  });

  it("respects limit after filtering", async () => {
    const { client: c } = client(routes);
    const parts = await c.searchResistors({ ohms: 10_000, limit: 2 });
    expect(parts).toHaveLength(2);
  });

  it("falls back to searchComponents with a human-readable query on API failure", async () => {
    const { client: c, calls } = client({
      "/resistors/list.json": () => jsonResponse("boom", 500),
      "/api/search": () => jsonResponse(fixture("api-search-ne555.json")),
      "/components/list.json": () => jsonResponse(fixture("components-empty.json")),
    });
    const parts = await c.searchResistors({ ohms: 10_000, package: "0603" });
    const apiCall = calls.find((u) => u.pathname === "/api/search")!;
    expect(apiCall.searchParams.get("q")).toBe("10k 0603");
    // fallback path returned whatever text search found (package-filtered)
    expect(parts.every((p) => p.package === "0603")).toBe(true);
  });
});

describe("JlcClient.searchCapacitors", () => {
  const routes: Record<string, Route> = {
    "/capacitors/list.json": () => jsonResponse(fixture("capacitors-100nf-0603.json")),
  };

  it("sends capacitance in farads and normalizes rows", async () => {
    const { client: c, calls } = client(routes);
    const parts = await c.searchCapacitors({ farads: 1e-7, package: "0603" });
    expect(calls[0].searchParams.get("capacitance")).toBe("1e-7");
    expect(parts).toHaveLength(4);
    expect(parts[0].lcsc).toBe("C14663");
    expect(parts[0].attributes?.Capacitance).toBe("100nF");
  });

  it("filters by minVoltage client-side (all fixture rows are 50V)", async () => {
    const { client: c } = client(routes);
    expect(await c.searchCapacitors({ farads: 1e-7, minVoltage: 100 })).toHaveLength(0);
    const { client: c2 } = client(routes);
    expect(await c2.searchCapacitors({ farads: 1e-7, minVoltage: 25 })).toHaveLength(4);
  });

  it("keeps rows with unknown voltage rating when minVoltage is set", async () => {
    const data = fixture("capacitors-100nf-0603.json");
    data.capacitors[0].voltage_rating = null;
    data.capacitors[0].attributes = "{}";
    const { client: c } = client({ "/capacitors/list.json": () => jsonResponse(data) });
    const parts = await c.searchCapacitors({ farads: 1e-7, minVoltage: 100 });
    expect(parts.map((p) => p.lcscId)).toEqual([data.capacitors[0].lcsc]);
  });

  it("drops rows whose capacitance drifts beyond 5%", async () => {
    const data = fixture("capacitors-100nf-0603.json");
    data.capacitors[2].capacitance_farads = 2.2e-7;
    const { client: c } = client({ "/capacitors/list.json": () => jsonResponse(data) });
    const parts = await c.searchCapacitors({ farads: 1e-7 });
    expect(parts.map((p) => p.lcscId)).not.toContain(data.capacitors[2].lcsc);
    expect(parts).toHaveLength(3);
  });

  it("falls back to text search with nF formatting on API failure", async () => {
    const { client: c, calls } = client({
      "/capacitors/list.json": () => jsonResponse("boom", 503),
      "/api/search": () => jsonResponse(fixture("components-empty.json")),
      "/components/list.json": () => jsonResponse(fixture("components-empty.json")),
    });
    await c.searchCapacitors({ farads: 1e-7, package: "0603" });
    const apiCall = calls.find((u) => u.pathname === "/api/search")!;
    expect(apiCall.searchParams.get("q")).toBe("100nF 0603");
  });
});

describe("JlcClient.getPart", () => {
  it("resolves an exact LCSC number via /components/list.json (rich row)", async () => {
    const { client: c, calls } = client({
      "/components/list.json": () => jsonResponse(fixture("components-c7593.json")),
    });
    const part = await c.getPart("C7593");
    expect(part?.lcsc).toBe("C7593");
    expect(part?.priceBreaks).toHaveLength(6);
    expect(part?.category).toBe("Clock and Timing");
    expect(calls).toHaveLength(1);
    expect(calls[0].searchParams.get("search")).toBe("C7593");
  });

  it("accepts bare numbers and digit strings", async () => {
    const { client: c } = client({
      "/components/list.json": () => jsonResponse(fixture("components-c25804.json")),
    });
    expect((await c.getPart(25804))?.lcsc).toBe("C25804");
    const { client: c2 } = client({
      "/components/list.json": () => jsonResponse(fixture("components-c25804.json")),
    });
    expect((await c2.getPart("25804"))?.lcsc).toBe("C25804");
  });

  it("rejects fuzzy matches whose lcsc differs from the requested id", async () => {
    // Both endpoints return NE555 rows, none of which is C999999999.
    const { client: c } = client({
      "/components/list.json": () => jsonResponse(fixture("components-ne555.json")),
      "/api/search": () => jsonResponse(fixture("api-search-ne555.json")),
    });
    expect(await c.getPart("C999999999")).toBeNull();
  });

  it("returns null when both endpoints return no rows", async () => {
    const { client: c } = client({
      "/components/list.json": () => jsonResponse(fixture("components-empty.json")),
      "/api/search": () => jsonResponse(fixture("components-empty.json")),
    });
    expect(await c.getPart("C999999999")).toBeNull();
  });

  it("falls back to /api/search when /components/list.json fails", async () => {
    const { client: c, calls } = client({
      "/components/list.json": () => jsonResponse("down", 500),
      "/api/search": () => jsonResponse(fixture("api-search-c7593.json")),
    });
    const part = await c.getPart("C7593");
    expect(part?.lcsc).toBe("C7593");
    // list.json tried twice (retry on 5xx), then api fallback
    expect(calls.map((u) => u.pathname)).toEqual([
      "/components/list.json",
      "/components/list.json",
      "/api/search",
    ]);
  });

  it("throws a combined error when both endpoints fail", async () => {
    const { client: c } = client({
      "/components/list.json": () => jsonResponse("down", 500),
      "/api/search": () => jsonResponse("down", 502),
    });
    await expect(c.getPart("C7593")).rejects.toThrow(/both endpoints/);
  });

  it("throws on garbage input without hitting the network", async () => {
    const { client: c, fetchFn } = client({});
    await expect(c.getPart("total garbage")).rejects.toThrow(/Invalid LCSC/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("JlcClient.getPassiveDetail", () => {
  // Real recorded responses: category-endpoint search=C<id> is fuzzy — the
  // exact part comes back WITH attributes, alongside unrelated neighbor rows.
  const routes: Record<string, Route> = {
    "/resistors/list.json": () => jsonResponse(fixture("resistors-search-c25804.json")),
    "/capacitors/list.json": () => jsonResponse(fixture("capacitors-search-c14663.json")),
  };

  it("resolves a resistor by C-number with parsed attributes", async () => {
    const { client: c, calls } = client(routes);
    const part = await c.getPassiveDetail("C25804", "resistor");
    expect(part?.lcsc).toBe("C25804");
    expect(part?.attributes?.Resistance).toBe("10kΩ");
    expect(part?.attributes?.Tolerance).toBe("±1%");
    expect(part?.tier).toBe("basic");
    expect(calls.map((u) => u.pathname)).toEqual(["/resistors/list.json"]);
    expect(calls[0].searchParams.get("search")).toBe("C25804");
  });

  it("resolves a capacitor by bare number with parsed attributes", async () => {
    const { client: c, calls } = client(routes);
    const part = await c.getPassiveDetail(14663, "capacitor");
    expect(part?.lcsc).toBe("C14663");
    expect(part?.attributes?.Capacitance).toBe("100nF");
    expect(part?.attributes?.["Voltage Rated"]).toBe("50V");
    expect(calls.map((u) => u.pathname)).toEqual(["/capacitors/list.json"]);
  });

  it("returns null when the fuzzy search rows lack the exact lcsc", async () => {
    // Fixture returns 10 fuzzy neighbor rows, none of which is C999999999.
    const { client: c } = client(routes);
    expect(await c.getPassiveDetail("C999999999", "resistor")).toBeNull();
  });

  it("throws on garbage input without hitting the network (toLcscId contract)", async () => {
    const { client: c, fetchFn } = client(routes);
    await expect(c.getPassiveDetail("total garbage", "resistor")).rejects.toThrow(/Invalid LCSC/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("JlcClient.listCategories", () => {
  it("returns category/subcategory pairs, preserving empty subcategories", async () => {
    const { client: c } = client({
      "/categories/list.json": () => jsonResponse(fixture("categories.json")),
    });
    const cats = await c.listCategories();
    expect(cats).toHaveLength(6);
    expect(cats[0]).toEqual({
      category: "ADC/DAC/Data Conversion",
      subcategory: "ADC/DAC - Specialized",
    });
    expect(cats.some((cat) => cat.subcategory === "")).toBe(true);
  });
});

describe("caching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves identical requests from cache within the 5 min TTL", async () => {
    const { client: c, fetchFn } = client({
      "/categories/list.json": () => jsonResponse(fixture("categories.json")),
    });
    await c.listCategories();
    await c.listCategories();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(4 * 60 * 1000);
    await c.listCategories();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refetches after the TTL expires", async () => {
    const { client: c, fetchFn } = client({
      "/categories/list.json": () => jsonResponse(fixture("categories.json")),
    });
    await c.listCategories();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await c.listCategories();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not cache failed requests", async () => {
    let call = 0;
    const { client: c, fetchFn } = client({
      "/categories/list.json": () =>
        ++call === 1
          ? jsonResponse("nope", 404)
          : jsonResponse(fixture("categories.json")),
    });
    await expect(c.listCategories()).rejects.toThrow(/404/);
    expect(await c.listCategories()).toHaveLength(6);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("retry and timeout behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries once on 5xx and succeeds", async () => {
    let call = 0;
    const { client: c, fetchFn } = client({
      "/categories/list.json": () =>
        ++call === 1 ? jsonResponse("err", 500) : jsonResponse(fixture("categories.json")),
    });
    expect(await c.listCategories()).toHaveLength(6);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("throws a descriptive error after two 5xx responses", async () => {
    const { client: c, fetchFn } = client({
      "/categories/list.json": () => jsonResponse("err", 500),
    });
    await expect(c.listCategories()).rejects.toThrow(/server error 500.*after retry/s);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("waits 1s then retries once on 429", async () => {
    let call = 0;
    const { client: c, fetchFn } = client({
      "/categories/list.json": () =>
        ++call === 1 ? jsonResponse("slow down", 429) : jsonResponse(fixture("categories.json")),
    });
    const pending = c.listCategories();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toHaveLength(6);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("gives up after a second 429", async () => {
    const { client: c, fetchFn } = client({
      "/categories/list.json": () => jsonResponse("slow down", 429),
    });
    const assertion = expect(c.listCategories()).rejects.toThrow(/rate limited.*after retry/s);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("retries once on network failure, then throws descriptively", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const c = new JlcClient({ fetchFn: fetchFn as unknown as typeof fetch });
    await expect(c.listCategories()).rejects.toThrow(/network failure.*fetch failed.*after retry/s);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("recovers when the second attempt succeeds after a network failure", async () => {
    let call = 0;
    const fetchFn = vi.fn(async () => {
      if (++call === 1) throw new TypeError("fetch failed");
      return jsonResponse(fixture("categories.json"));
    });
    const c = new JlcClient({ fetchFn: fetchFn as unknown as typeof fetch });
    expect(await c.listCategories()).toHaveLength(6);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not retry 4xx client errors", async () => {
    const { client: c, fetchFn } = client({
      "/categories/list.json": () => jsonResponse("nope", 404),
    });
    await expect(c.listCategories()).rejects.toThrow(/HTTP 404/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("aborts requests that exceed timeoutMs and retries once", async () => {
    const fetchFn = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const c = new JlcClient({ fetchFn: fetchFn as unknown as typeof fetch, timeoutMs: 50 });
    const assertion = expect(c.listCategories()).rejects.toThrow(/network failure.*after retry/s);
    await vi.advanceTimersByTimeAsync(50); // first attempt aborts
    await vi.advanceTimersByTimeAsync(50); // retry aborts too
    await assertion;
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
