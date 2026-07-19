/**
 * JlcRemoteClient — talks to our hosted catalog API (the Cloudflare D1 Worker
 * in worker/). The Worker already returns the project's `Part` JSON, so this is
 * a thin fetch wrapper: teammates get catalog search with no local DB download
 * by pointing the server at the Worker via JLCPCB_API_URL.
 *
 * Implements the same surface as JlcClient / JlcDbClient (JlcClientLike).
 */
import type {
  CapacitorSearchOptions,
  Part,
  ResistorSearchOptions,
  SearchOptions,
} from "../types.js";

export interface JlcRemoteOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class JlcRemoteClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(opts: JlcRemoteOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 10000;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async get<T>(path: string): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.base}${path}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`jlcpcb-api ${res.status} for ${path}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private qs(params: Record<string, string | number | undefined>): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") sp.set(k, String(v));
    const s = sp.toString();
    return s ? `?${s}` : "";
  }

  searchComponents(opts: SearchOptions): Promise<Part[]> {
    return this.get<Part[]>(
      `/search${this.qs({
        q: opts.q,
        package: opts.package,
        tier: opts.tier,
        min_stock: opts.minStock,
        limit: opts.limit,
      })}`,
    );
  }

  searchResistors(opts: ResistorSearchOptions): Promise<Part[]> {
    return this.get<Part[]>(
      `/resistors${this.qs({
        ohms: opts.ohms,
        package: opts.package,
        max_tolerance: opts.maxTolerance,
        limit: opts.limit,
      })}`,
    );
  }

  searchCapacitors(opts: CapacitorSearchOptions): Promise<Part[]> {
    return this.get<Part[]>(
      `/capacitors${this.qs({
        farads: opts.farads,
        package: opts.package,
        min_voltage: opts.minVoltage,
        limit: opts.limit,
      })}`,
    );
  }

  getPart(lcsc: string | number): Promise<Part | null> {
    const id = String(lcsc).replace(/^c/i, "");
    return this.get<Part | null>(`/part/C${id}`);
  }

  getPassiveDetail(lcsc: string | number, kind: "resistor" | "capacitor"): Promise<Part | null> {
    const id = String(lcsc).replace(/^c/i, "");
    return this.get<Part | null>(`/passive/${kind}/C${id}`);
  }

  listCategories(): Promise<{ category: string; subcategory: string }[]> {
    return this.get<{ category: string; subcategory: string }[]>(`/categories`);
  }
}
