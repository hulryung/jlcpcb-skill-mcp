/**
 * jlcpcb-parts-api — Cloudflare Worker serving the JLCPCB catalog from D1.
 *
 * Hosts the trimmed in-stock catalog (~693k parts, built by
 * scripts/build-d1-db.ts) so teammates get catalog search with zero local
 * download. Returns the project's `Part` JSON directly; the local MCP server
 * consumes it via JlcRemoteClient (src/jlc/remote.ts) by setting
 * JLCPCB_API_URL, so no other client code changes.
 *
 * Endpoints (all GET, JSON):
 *   /health                 → { ok, rows }
 *   /search?q&package&tier&min_stock&limit   → Part[]
 *   /resistors?ohms&package&max_tolerance&limit → Part[]
 *   /capacitors?farads&package&min_voltage&limit → Part[]
 *   /part/<lcsc>            → Part | null   (proxies jlcsearch for fresh stock + preferred tier)
 *   /passive/<kind>/<lcsc>  → Part | null
 *   /categories            → { category, subcategory }[]
 *
 * D1 read budget (free plan: 5M rows read / day). The catalog is a snapshot, so
 * every D1-backed GET is cached at the edge for a day, FTS candidates are capped
 * before the join/sort, and nothing does a full-table scan on the request path.
 * See worker/README.md "Read budget".
 */

// Minimal ambient D1 types so the Worker needs no extra dependency to typecheck;
// wrangler provides the real runtime binding.
interface D1Result<T = Record<string, unknown>> {
  results: T[];
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = unknown>(col?: string): Promise<T | null>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
}
interface Env {
  DB: D1Database;
  /** Live jlcsearch base URL for get_part enrichment. Optional. */
  JLCSEARCH_URL?: string;
}
interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}
interface CfCache {
  match(req: Request): Promise<Response | undefined>;
  put(req: Request, res: Response): Promise<void>;
}

/**
 * Max FTS rowids pulled before joining `parts` and sorting by stock. Typical
 * searches match a few hundred rows; a very common token ("10k", "resistor")
 * matches tens of thousands, and without a cap every one is a billed D1 read
 * even though we return ≤50. 20k bounds the worst query at ≈40k rows read
 * (FTS rowids + joined parts) — under 1% of the free daily budget — while
 * leaving ordinary queries untouched so stock ranking stays exact for them.
 * Candidates come back in rowid order (not bm25): ranking by relevance would
 * have to read the docsize shadow table for every match, which defeats the cap.
 */
const FTS_CANDIDATE_CAP = 20000;
/** Catalog is a static snapshot; cache D1-backed responses at the edge for a day. */
const CACHE_TTL_SECONDS = 86400;

// --- Part shape (kept in sync with src/types.ts) --------------------------
interface PriceBreak {
  qFrom: number;
  qTo: number | null;
  price: number;
}
type PartTier = "basic" | "preferred" | "extended";
interface Part {
  lcsc: string;
  lcscId: number;
  mfr: string;
  description: string;
  package: string;
  category?: string;
  subcategory?: string;
  stock: number;
  tier: PartTier;
  priceBreaks: PriceBreak[];
  unitPrice: number | null;
  attributes?: Record<string, string>;
  productUrl: string;
}

interface DbRow {
  lcsc: string;
  mfr: string | null;
  package: string | null;
  category: string | null;
  subcategory: string | null;
  manufacturer: string | null;
  library_type: string | null;
  description: string | null;
  price: string | null;
  stock: number | null;
  datasheet: string | null;
}

const SELECT_COLS =
  "lcsc, mfr, package, category, subcategory, manufacturer, library_type, description, price, stock, datasheet";

function parsePriceBreaks(price: string | null | undefined): PriceBreak[] {
  if (!price) return [];
  const breaks: PriceBreak[] = [];
  for (const tier of price.split(",")) {
    const m = /^(\d+)-(\d*):([\d.]+)$/.exec(tier.trim());
    if (!m) continue;
    breaks.push({
      qFrom: Number(m[1]),
      qTo: m[2] === "" ? null : Number(m[2]),
      price: Number(m[3]),
    });
  }
  return breaks.sort((a, b) => a.qFrom - b.qFrom);
}

function extractAttributes(desc: string, manufacturer: string | null, datasheet: string | null): Record<string, string> {
  const attrs: Record<string, string> = {};
  const res = /(\d+(?:\.\d+)?[kKmMrRgG]?)\s*(?:Ω|ohm|Ω)/i.exec(desc) || /(\d+(?:\.\d+)?)\s*k?Ω/i.exec(desc);
  const ohm = /(\d+(?:\.\d+)?\s*[kKmMgG]?Ω)/.exec(desc);
  if (ohm) attrs.Resistance = ohm[1].replace(/\s+/g, "");
  const cap = /(\d+(?:\.\d+)?\s*[pnuµμmf]F)/i.exec(desc);
  if (cap) attrs.Capacitance = cap[1].replace(/\s+/g, "");
  const tol = /±\s*(\d+(?:\.\d+)?)\s*%/.exec(desc);
  if (tol) attrs.Tolerance = `±${tol[1]}%`;
  const volt = /(\d+(?:\.\d+)?)\s*V(?![a-z])/i.exec(desc);
  if (volt) attrs["Voltage Rated"] = `${volt[1]}V`;
  if (manufacturer) attrs.Manufacturer = manufacturer;
  if (datasheet) attrs.Datasheet = datasheet;
  attrs["Data Source"] = "cloudflare-d1 (snapshot stock)";
  attrs["Tier Note"] =
    "hosted catalog lists only Basic/Extended — part may be preferred-extended (fee waived); get_part verifies via live API";
  return attrs;
}

function rowToPart(row: DbRow): Part {
  const lcsc = row.lcsc;
  const lcscId = Number(lcsc.replace(/^C/i, "")) || 0;
  const breaks = parsePriceBreaks(row.price);
  const desc = row.description ?? "";
  return {
    lcsc,
    lcscId,
    mfr: row.mfr ?? "",
    description: desc,
    package: row.package ?? "",
    category: row.category ?? undefined,
    subcategory: row.subcategory ?? undefined,
    stock: row.stock ?? 0,
    tier: row.library_type === "Basic" ? "basic" : "extended",
    priceBreaks: breaks,
    unitPrice: breaks.length ? breaks[0].price : null,
    attributes: extractAttributes(desc, row.manufacturer, row.datasheet),
    productUrl: `https://jlcpcb.com/partdetail/${lcsc}`,
  };
}

// --- FTS helpers ----------------------------------------------------------
/** unicode61 FTS token: quote and drop metacharacters; <3-char tokens are dropped (caller LIKEs). */
function ftsToken(t: string): string {
  return `"${t.replace(/["]/g, "")}"`;
}
function canFts(t: string): boolean {
  return t.replace(/[^0-9a-zA-ZÀ-￿]/g, "").length >= 3;
}
function clampLimit(v: string | null, def: number): number {
  const n = v ? parseInt(v, 10) : def;
  return Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : def;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

// --- Queries --------------------------------------------------------------
async function search(env: Env, url: URL): Promise<Part[]> {
  const q = (url.searchParams.get("q") ?? "").trim();
  const pkg = url.searchParams.get("package")?.trim();
  const tier = url.searchParams.get("tier");
  const minStock = url.searchParams.get("min_stock");
  const limit = clampLimit(url.searchParams.get("limit"), 10);

  const tokens = q ? q.split(/\s+/) : [];
  const ftsTokens = tokens.filter(canFts);
  const likeTokens = tokens.filter((t) => !canFts(t));

  // Every search must narrow through the FTS index first. Package/tier/LIKE-only
  // searches used to scan all ~693k rows (one request = 14% of the daily free
  // read budget), so they now return nothing instead of a full-table scan.
  if (!ftsTokens.length) return [];

  const where: string[] = [
    `p.rowid IN (SELECT rowid FROM parts_fts WHERE parts_fts MATCH ? LIMIT ${FTS_CANDIDATE_CAP})`,
  ];
  const binds: unknown[] = [ftsTokens.map(ftsToken).join(" AND ")];
  for (const t of likeTokens) {
    where.push("(p.description LIKE ? OR p.mfr LIKE ?)");
    binds.push(`%${t}%`, `%${t}%`);
  }
  if (pkg) {
    where.push("p.package = ? COLLATE NOCASE");
    binds.push(pkg);
  }
  if (tier === "basic" || tier === "preferred") where.push("p.library_type = 'Basic'");
  if (minStock && Number(minStock) > 0) {
    where.push("p.stock >= ?");
    binds.push(Math.floor(Number(minStock)));
  }
  const sql =
    `SELECT ${SELECT_COLS.replace(/(^|, )/g, "$1p.")} FROM parts p WHERE ${where.join(" AND ")} ` +
    `ORDER BY (p.library_type = 'Basic') DESC, p.stock DESC LIMIT ?`;
  binds.push(limit);
  const { results } = await env.DB.prepare(sql).bind(...binds).all<DbRow>();
  return results.map(rowToPart);
}

/** Numeric-value variants used to token-match resistor/capacitor rows. */
function resistanceVariants(ohms: number): string[] {
  const out = new Set<string>();
  const push = (v: string) => out.add(v);
  if (ohms >= 1e6) push(`${trim(ohms / 1e6)}MΩ`), push(`${trim(ohms / 1e6)}M`);
  else if (ohms >= 1e3) push(`${trim(ohms / 1e3)}kΩ`), push(`${trim(ohms / 1e3)}k`);
  else push(`${trim(ohms)}Ω`), push(`${trim(ohms)}R`);
  return [...out].filter(canFts);
}
function capacitanceVariants(farads: number): string[] {
  const out = new Set<string>();
  if (farads >= 1e-6) out.add(`${trim(farads / 1e-6)}uF`), out.add(`${trim(farads / 1e-6)}µF`);
  else if (farads >= 1e-9) out.add(`${trim(farads / 1e-9)}nF`);
  else out.add(`${trim(farads / 1e-12)}pF`);
  return [...out].filter(canFts);
}
function trim(n: number): string {
  return String(Number(n.toFixed(4)));
}

async function searchPassive(
  env: Env,
  url: URL,
  category: string,
  variants: string[],
): Promise<Part[]> {
  const pkg = url.searchParams.get("package")?.trim();
  const limit = clampLimit(url.searchParams.get("limit"), 10);
  if (!variants.length) return [];
  const where = [
    `p.rowid IN (SELECT rowid FROM parts_fts WHERE parts_fts MATCH ? LIMIT ${FTS_CANDIDATE_CAP})`,
    "p.category = ?",
  ];
  const binds: unknown[] = [variants.map(ftsToken).join(" OR "), category];
  if (pkg) {
    where.push("p.package = ? COLLATE NOCASE");
    binds.push(pkg);
  }
  const sql =
    `SELECT ${SELECT_COLS.replace(/(^|, )/g, "$1p.")} FROM parts p ` +
    `WHERE ${where.join(" AND ")} ORDER BY (p.library_type = 'Basic') DESC, p.stock DESC LIMIT ?`;
  binds.push(Math.max(limit * 4, 40));
  const { results } = await env.DB.prepare(sql).bind(...binds).all<DbRow>();
  return results.map(rowToPart).slice(0, Math.max(limit * 4, 40));
}

async function dbPart(env: Env, lcsc: string): Promise<Part | null> {
  const row = await env.DB.prepare(`SELECT ${SELECT_COLS} FROM parts WHERE lcsc = ? LIMIT 1`)
    .bind(lcsc.toUpperCase())
    .first<DbRow>();
  return row ? rowToPart(row) : null;
}

/** get_part: prefer live jlcsearch (fresh stock + preferred tier); fall back to D1. */
async function getPart(env: Env, lcsc: string): Promise<Part | null> {
  const base = env.JLCSEARCH_URL ?? "https://jlcsearch.tscircuit.com";
  const id = lcsc.replace(/^C/i, "");
  try {
    const r = await fetch(`${base}/components/list.json?search=C${id}&full=true`, {
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const data = (await r.json()) as { components?: Array<Record<string, unknown>> };
      const hit = (data.components ?? []).find((c) => String(c.lcsc) === id);
      if (hit) {
        // jlcsearch returns price as a JSON-string of breaks; tier from is_basic/is_preferred.
        let pb: PriceBreak[] = [];
        try {
          pb = (JSON.parse(String(hit.price)) as PriceBreak[]).map((b) => ({
            qFrom: b.qFrom,
            qTo: b.qTo ?? null,
            price: b.price,
          }));
        } catch {
          pb = [];
        }
        const tier: PartTier = hit.is_basic ? "basic" : hit.is_preferred ? "preferred" : "extended";
        return {
          lcsc: `C${id}`,
          lcscId: Number(id),
          mfr: String(hit.mfr ?? ""),
          description: String(hit.description ?? ""),
          package: String(hit.package ?? ""),
          category: hit.category ? String(hit.category) : undefined,
          subcategory: hit.subcategory ? String(hit.subcategory) : undefined,
          stock: Number(hit.stock ?? 0),
          tier,
          priceBreaks: pb,
          unitPrice: pb.length ? pb[0].price : null,
          attributes: { "Data Source": "live jlcsearch (via hosted get_part)" },
          productUrl: `https://jlcpcb.com/partdetail/C${id}`,
        };
      }
    }
  } catch {
    // fall through to D1 snapshot
  }
  return dbPart(env, `C${id}`);
}

async function categories(env: Env): Promise<{ category: string; subcategory: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT category, subcategory FROM parts WHERE category <> '' ORDER BY category, subcategory`,
  ).all<{ category: string; subcategory: string }>();
  return results;
}

/** Serve from the edge cache when possible; otherwise compute, cache for a day, return. */
async function cached(
  request: Request,
  ctx: ExecutionContext,
  compute: () => Promise<Response>,
): Promise<Response> {
  const cache = (caches as unknown as { default: CfCache }).default;
  const key = new Request(request.url, { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await compute();
  if (res.status === 200) {
    const toStore = new Response(res.body, res);
    toStore.headers.set("cache-control", `public, max-age=${CACHE_TTL_SECONDS}`);
    ctx.waitUntil(cache.put(key, toStore.clone()));
    return toStore;
  }
  return res;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    try {
      if (path === "" || path === "/health") {
        // One indexed row, not COUNT(*): on D1 a COUNT over `parts` is a full scan
        // of ~693k billed reads per call, and health checks are called often.
        const row = await env.DB.prepare(`SELECT lcsc FROM parts LIMIT 1`).first<string>("lcsc");
        return json({ ok: row != null });
      }
      if (path === "/search") return cached(request, ctx, async () => json(await search(env, url)));
      if (path === "/resistors") {
        const ohms = Number(url.searchParams.get("ohms"));
        return cached(request, ctx, async () =>
          json(Number.isFinite(ohms) ? await searchPassive(env, url, "Resistors", resistanceVariants(ohms)) : []),
        );
      }
      if (path === "/capacitors") {
        const farads = Number(url.searchParams.get("farads"));
        return cached(request, ctx, async () =>
          json(Number.isFinite(farads) ? await searchPassive(env, url, "Capacitors", capacitanceVariants(farads)) : []),
        );
      }
      // DISTINCT over the whole table is a full scan; the category list changes
      // only when the catalog is re-imported, so a day in cache is plenty.
      if (path === "/categories") return cached(request, ctx, async () => json(await categories(env)));
      const partMatch = /^\/part\/(C?\d+)$/i.exec(path);
      if (partMatch) return json(await getPart(env, partMatch[1]));
      const passiveMatch = /^\/passive\/(resistor|capacitor)\/(C?\d+)$/i.exec(path);
      if (passiveMatch) {
        return cached(request, ctx, async () => {
          const p = await dbPart(env, passiveMatch[2]);
          const want = passiveMatch[1] === "resistor" ? "Resistors" : "Capacitors";
          return json(p && p.category === want ? p : null);
        });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  },
};
