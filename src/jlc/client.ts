/**
 * HTTP client for the jlcsearch API (https://jlcsearch.tscircuit.com).
 * Endpoint behaviors (which params work, which are ignored) are documented in
 * docs/jlcsearch-api-notes.md — several `limit` params are silently ignored
 * server-side, so all limits are re-applied client-side.
 */
import type {
  CapacitorSearchOptions,
  Part,
  PartTier,
  ResistorSearchOptions,
  SearchOptions,
} from "../types.js";
import {
  normalizeCapacitor,
  normalizeComponent,
  normalizeResistor,
  toLcscId,
} from "./normalize.js";

export interface JlcClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://jlcsearch.tscircuit.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_LIMIT = 20;
const CACHE_TTL_MS = 5 * 60 * 1000;
const RETRY_429_DELAY_MS = 1000;
// Server limit params are unreliable; ask big once, trim client-side (cache-friendly).
const SERVER_FETCH_LIMIT = 100;

interface CacheEntry {
  expiresAt: number;
  data: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function packageMatches(partPackage: string, wanted: string | undefined): boolean {
  if (wanted === undefined || wanted === "") return true;
  return partPackage.toLowerCase() === wanted.toLowerCase();
}

// Per types.ts: requesting "basic" also admits preferred parts (both are
// fee-free-ish); "extended" means no restriction.
function tierMatches(partTier: PartTier, wanted: PartTier | undefined): boolean {
  if (wanted === undefined || wanted === "extended") return true;
  return partTier === "basic" || partTier === "preferred";
}

function byStockDesc(a: Part, b: Part): number {
  return b.stock - a.stock;
}

/** Relative spec check guarding against server-side param drift. */
function approxEquals(actual: number, expected: number, relTol: number): boolean {
  return Math.abs(actual - expected) <= relTol * Math.abs(expected);
}

function rowsOf(data: unknown, key: string, url: string): unknown[] {
  if (typeof data === "object" && data !== null) {
    const rows = (data as Record<string, unknown>)[key];
    if (Array.isArray(rows)) return rows;
  }
  throw new Error(`jlcsearch: unexpected response shape from ${url} (missing "${key}" array)`);
}

export class JlcClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts?: JlcClientOptions) {
    this.baseUrl = (opts?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = opts?.fetchFn ?? fetch;
  }

  /** Free-text search via /api/search + /components/list.json (merged, deduped by lcsc). */
  async searchComponents(opts: SearchOptions): Promise<Part[]> {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const q = opts.q?.trim() ?? "";

    const byId = new Map<number, Part>();
    if (q !== "") {
      // Sequential (concurrency 1) to be polite to the API.
      const searchParams: Record<string, string> = {
        q,
        limit: String(SERVER_FETCH_LIMIT),
        full: "true",
      };
      if (opts.package) searchParams.package = opts.package;
      const searchRows = await this.getRowsWithPackageFallback(
        "/api/search",
        searchParams,
        "components",
      );
      for (const row of searchRows) {
        const part = tryNormalize(row, normalizeComponent);
        if (part) byId.set(part.lcscId, part);
      }
    }

    const listParams: Record<string, string> = { full: "true", limit: String(SERVER_FETCH_LIMIT) };
    if (q !== "") listParams.search = q;
    if (opts.package) listParams.package = opts.package;
    const listRows = await this.getRowsWithPackageFallback(
      "/components/list.json",
      listParams,
      "components",
    );
    for (const row of listRows) {
      const part = tryNormalize(row, normalizeComponent);
      if (part) byId.set(part.lcscId, mergeParts(byId.get(part.lcscId), part));
    }

    return [...byId.values()]
      .filter(
        (p) =>
          packageMatches(p.package, opts.package) &&
          p.stock >= (opts.minStock ?? 0) &&
          tierMatches(p.tier, opts.tier),
      )
      .sort(byStockDesc)
      .slice(0, limit);
  }

  /** Parametric resistor search. Falls back to searchComponents on API failure. */
  async searchResistors(opts: ResistorSearchOptions): Promise<Part[]> {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const params: Record<string, string> = { limit: String(SERVER_FETCH_LIMIT) };
    if (opts.ohms !== undefined) params.resistance = String(opts.ohms);
    if (opts.package) params.package = opts.package;

    let rows: unknown[];
    try {
      const data = await this.getJson("/resistors/list.json", params);
      rows = rowsOf(data, "resistors", "/resistors/list.json");
    } catch {
      return this.searchComponents({
        q: [opts.ohms !== undefined ? formatOhms(opts.ohms) : "resistor", opts.package]
          .filter(Boolean)
          .join(" "),
        package: opts.package,
        limit,
      });
    }

    const parts: Part[] = [];
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      if (
        opts.maxTolerance !== undefined &&
        typeof r.tolerance_fraction === "number" &&
        r.tolerance_fraction > opts.maxTolerance
      ) {
        continue;
      }
      if (
        opts.ohms !== undefined &&
        typeof r.resistance === "number" &&
        !approxEquals(r.resistance, opts.ohms, 0.005)
      ) {
        continue;
      }
      const part = tryNormalize(row, normalizeResistor);
      if (part && packageMatches(part.package, opts.package)) parts.push(part);
    }
    return parts.sort(byStockDesc).slice(0, limit);
  }

  /** Parametric capacitor search. Falls back to searchComponents on API failure. */
  async searchCapacitors(opts: CapacitorSearchOptions): Promise<Part[]> {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const params: Record<string, string> = { limit: String(SERVER_FETCH_LIMIT) };
    // API expects farads as a plain number; "1e-7" and "0.0000001" both work.
    if (opts.farads !== undefined) params.capacitance = String(opts.farads);
    if (opts.package) params.package = opts.package;

    let rows: unknown[];
    try {
      const data = await this.getJson("/capacitors/list.json", params);
      rows = rowsOf(data, "capacitors", "/capacitors/list.json");
    } catch {
      return this.searchComponents({
        q: [opts.farads !== undefined ? formatFarads(opts.farads) : "capacitor", opts.package]
          .filter(Boolean)
          .join(" "),
        package: opts.package,
        limit,
      });
    }

    const parts: Part[] = [];
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      if (
        opts.farads !== undefined &&
        typeof r.capacitance_farads === "number" &&
        !approxEquals(r.capacitance_farads, opts.farads, 0.05)
      ) {
        continue;
      }
      if (opts.minVoltage !== undefined) {
        const rating = voltageRatingOf(r);
        // Unknown voltage rating is kept (cannot disprove) — only filter known-bad.
        if (rating !== undefined && rating < opts.minVoltage) continue;
      }
      const part = tryNormalize(row, normalizeCapacitor);
      if (part && packageMatches(part.package, opts.package)) parts.push(part);
    }
    return parts.sort(byStockDesc).slice(0, limit);
  }

  /** Lookup by LCSC number ("C25804" | 25804 | "25804"). Null if not found. */
  async getPart(lcsc: string | number): Promise<Part | null> {
    const id = toLcscId(lcsc);
    const canonical = `C${id}`;

    // /components/list.json is richer (price breaks + category); /api/search is
    // the fallback. Search can be fuzzy, so require an exact lcsc match.
    let fromList: Part | null = null;
    let listError: unknown;
    try {
      const data = await this.getJson("/components/list.json", {
        search: canonical,
        full: "true",
        limit: "10",
      });
      fromList = findExact(rowsOf(data, "components", "/components/list.json"), id);
    } catch (err) {
      listError = err;
    }
    if (fromList) return fromList;

    try {
      const data = await this.getJson("/api/search", { q: canonical, limit: "10", full: "true" });
      return findExact(rowsOf(data, "components", "/api/search"), id);
    } catch (err) {
      if (listError !== undefined) {
        throw new Error(
          `jlcsearch: getPart(${canonical}) failed on both endpoints: ${errMessage(listError)}; ${errMessage(err)}`,
        );
      }
      throw err;
    }
  }

  /** Category-endpoint lookup returning the part WITH parsed attributes (Resistance/Tolerance/Capacitance...), or null. */
  async getPassiveDetail(lcsc: string | number, kind: "resistor" | "capacitor"): Promise<Part | null> {
    const id = toLcscId(lcsc);
    const path = kind === "resistor" ? "/resistors/list.json" : "/capacitors/list.json";
    const key = kind === "resistor" ? "resistors" : "capacitors";
    const normalize = kind === "resistor" ? normalizeResistor : normalizeCapacitor;
    // search=C<id> works on category endpoints but can go fuzzy (returns up to
    // ~100 related rows) — an exact lcsc match is required.
    const data = await this.getJson(path, { search: `C${id}` });
    return findExact(rowsOf(data, key, path), id, normalize);
  }

  async listCategories(): Promise<{ category: string; subcategory: string }[]> {
    const data = await this.getJson("/categories/list.json", {});
    return rowsOf(data, "categories", "/categories/list.json").flatMap((row) => {
      const r = row as Record<string, unknown>;
      if (typeof r.category !== "string") return [];
      return [{ category: r.category, subcategory: typeof r.subcategory === "string" ? r.subcategory : "" }];
    });
  }

  /**
   * GET rows for `path`, retrying once WITHOUT the `package` param when a
   * package-filtered call yields zero rows. The server matches `package=`
   * case-sensitively ("soic-8" silently returns 0 rows where "SOIC-8" has
   * hits), so the retry recovers the unfiltered rows and leaves matching to
   * the case-insensitive client-side packageMatches filter. Both request
   * variants are cached as usual by getJson.
   */
  private async getRowsWithPackageFallback(
    path: string,
    params: Record<string, string>,
    key: string,
  ): Promise<unknown[]> {
    const data = await this.getJson(path, params);
    const rows = rowsOf(data, key, path);
    if (rows.length > 0 || params.package === undefined) return rows;
    const { package: _omitted, ...withoutPackage } = params;
    const retryData = await this.getJson(path, withoutPackage);
    return rowsOf(retryData, key, path);
  }

  private async getJson(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const key = url.toString();

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    const data = await this.fetchWithRetry(key);
    if (this.cache.size >= 500) this.pruneCache();
    this.cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, data });
    return data;
  }

  private pruneCache(): void {
    const now = Date.now();
    for (const [k, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(k);
    }
    if (this.cache.size >= 500) this.cache.clear();
  }

  /** One attempt + one retry (network failure/5xx immediate, 429 after 1s). */
  private async fetchWithRetry(url: string): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchFn(url, {
          signal: controller.signal,
          headers: { accept: "application/json" },
        });
        if (res.status === 429) {
          lastError = new Error(`jlcsearch: rate limited (429) at ${url}`);
          if (attempt === 0) await sleep(RETRY_429_DELAY_MS);
          continue;
        }
        if (res.status >= 500) {
          lastError = new Error(`jlcsearch: server error ${res.status} at ${url}`);
          continue;
        }
        if (!res.ok) {
          throw new Error(`jlcsearch: request failed with HTTP ${res.status} at ${url}`);
        }
        return (await res.json()) as unknown;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("jlcsearch:")) throw err;
        lastError = new Error(
          `jlcsearch: network failure fetching ${url} (timeout ${this.timeoutMs}ms): ${errMessage(err)}`,
        );
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error
      ? new Error(`${lastError.message} (after retry)`)
      : new Error(`jlcsearch: request failed at ${url} (after retry)`);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function tryNormalize(row: unknown, normalize: (raw: unknown) => Part): Part | null {
  try {
    return normalize(row);
  } catch {
    return null; // one malformed row must not sink the whole result set
  }
}

function findExact(
  rows: unknown[],
  id: number,
  normalize: (raw: unknown) => Part = normalizeComponent,
): Part | null {
  for (const row of rows) {
    const part = tryNormalize(row, normalize);
    if (part && part.lcscId === id) return part;
  }
  return null;
}

/** Merge duplicate rows for one lcsc id, keeping the richer fields of each. */
function mergeParts(existing: Part | undefined, incoming: Part): Part {
  if (!existing) return incoming;
  const [rich, poor] =
    incoming.priceBreaks.length >= existing.priceBreaks.length
      ? [incoming, existing]
      : [existing, incoming];
  return {
    ...rich,
    description: rich.description || poor.description,
    category: rich.category ?? poor.category,
    subcategory: rich.subcategory ?? poor.subcategory,
    attributes: rich.attributes ?? poor.attributes,
    stock: Math.max(rich.stock, poor.stock),
  };
}

/** 10000 → "10k", 4700 → "4.7k", 1000000 → "1M", 470 → "470" (fallback query text). */
function formatOhms(ohms: number): string {
  if (ohms >= 1e6) return trimNum(ohms / 1e6) + "M";
  if (ohms >= 1e3) return trimNum(ohms / 1e3) + "k";
  return trimNum(ohms);
}

/** 1e-7 → "100nF", 4.7e-6 → "4.7uF", 1e-11 → "10pF" (fallback query text). */
function formatFarads(farads: number): string {
  if (farads >= 1e-6) return trimNum(farads * 1e6) + "uF";
  if (farads >= 1e-9) return trimNum(farads * 1e9) + "nF";
  return trimNum(farads * 1e12) + "pF";
}

function trimNum(n: number): string {
  return String(Number(n.toFixed(3)));
}

function voltageRatingOf(r: Record<string, unknown>): number | undefined {
  if (typeof r.voltage_rating === "number" && Number.isFinite(r.voltage_rating)) {
    return r.voltage_rating;
  }
  const attrs = r.attributes;
  if (typeof attrs === "string") {
    const m = /"Voltage Rated"\s*:\s*"([\d.]+)\s*k?V/i.exec(attrs);
    if (m) {
      const v = Number(m[1]);
      if (Number.isFinite(v)) return /k[Vv]/.test(m[0]) ? v * 1000 : v;
    }
  }
  return undefined;
}
