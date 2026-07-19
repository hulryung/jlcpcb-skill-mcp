/**
 * Local JLCPCB parts catalog client backed by the FTS5 SQLite snapshot that
 * `npm run db:update` downloads (scripts/update-db.ts). Every schema fact and
 * SQL shape here was verified against the real DB — see docs/parts-db-notes.md
 * before changing any query:
 *   - one FTS5 virtual table `parts` (trigram tokenizer → SUBSTRING matching:
 *     "10kΩ" also matches "510kΩ", so parametric hits are re-verified here);
 *   - MATCH is the ONLY fast path (non-MATCH queries are 7M-row full scans);
 *   - MATCH tokens shorter than 3 chars silently match nothing → LIKE fallback;
 *   - "Stock"/"Price" are unindexed TEXT — filter with plain SQL after MATCH
 *     (a MATCH column filter on them returns 0 rows silently);
 *   - "Library Type" holds only Basic/Extended — JLCPCB preferred-extended is
 *     NOT distinguishable in this DB (jlcsearch is_preferred stays authoritative).
 *
 * All methods are synchronous SQLite under the hood, wrapped in an async
 * surface so JlcDbClient is drop-in compatible with JlcClient (JlcClientLike).
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type {
  CapacitorSearchOptions,
  Part,
  PartTier,
  PriceBreak,
  ResistorSearchOptions,
  SearchOptions,
} from "../types.js";
import { toLcscId } from "./normalize.js";

const DEFAULT_LIMIT = 20;
/** Fetch headroom before client-side spec verification trims wrong-value rows. */
const VERIFY_FETCH_MIN = 200;
const VERIFY_FETCH_MAX = 1000;

// Spec readers — same patterns as src/engine/rank.ts's private description
// readers, so values verified here also survive the engine's hard filters.
const RES_MULT: Record<string, number> = {
  p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, "μ": 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9,
};
const CAP_MULT: Record<string, number> = {
  p: 1e-12, P: 1e-12, n: 1e-9, N: 1e-9, u: 1e-6, U: 1e-6, "µ": 1e-6, "μ": 1e-6, m: 1e-3,
};
// Ω (U+2126 ohm sign) and Ω (U+03A9 greek omega) both appear in descriptions.
const RES_DESC_RE = /(\d+(?:\.\d+)?)\s*([pnuµμmkKMG])?\s*(?:Ω|Ω|[Oo][Hh][Mm][Ss]?\b)/;
const CAP_DESC_RE = /(\d+(?:\.\d+)?)\s*([pPnNuUµμm])F(?![A-Za-z])/;
const TOL_RE = /±\s*(\d+(?:\.\d+)?)\s*%/;
const VOLT_RE = /(\d+(?:\.\d+)?)\s*([kK])?V(?![A-Za-z0-9])/;

/** Recorded on extended-tier parts: this DB cannot see preferred-extended. */
const TIER_NOTE =
  "local DB lists only Basic/Extended — part may be preferred-extended (fee waived); verify via live API";

const requireModule = createRequire(import.meta.url);

type SqliteModule = typeof import("node:sqlite");

/** Lazy so merely importing this module never crashes on Node < 22. */
function loadSqlite(): SqliteModule {
  try {
    return requireModule("node:sqlite") as SqliteModule;
  } catch {
    throw new Error(
      `node:sqlite is unavailable on Node ${process.versions.node} — the local parts DB needs Node >= 22 ` +
        `(ideally >= 23.4 where node:sqlite is unflagged). Without it the server uses the live jlcsearch API.`,
    );
  }
}

/** ${XDG_CACHE_HOME:-~/.cache}/jlcpcb-parts/parts-fts5.db — matches scripts/update-db.ts. */
export function defaultDbPath(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const cacheRoot = xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".cache");
  return join(cacheRoot, "jlcpcb-parts", "parts-fts5.db");
}

/**
 * Open the local DB if possible: explicitPath (e.g. from JLCPCB_PARTS_DB) or
 * the default cache path. Returns null — never throws — when the file is
 * absent or node:sqlite is missing, so callers can fall back to the live API.
 */
export function openDbIfAvailable(explicitPath?: string): JlcDbClient | null {
  const dbPath = explicitPath && explicitPath.trim() !== "" ? explicitPath.trim() : defaultDbPath();
  try {
    return new JlcDbClient({ dbPath });
  } catch {
    return null;
  }
}

export class JlcDbClient {
  private readonly db: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();

  constructor(opts: { dbPath: string }) {
    const sqlite = loadSqlite();
    if (!existsSync(opts.dbPath)) {
      throw new Error(
        `Local parts DB not found at ${opts.dbPath} — run "npm run db:update" to download it ` +
          `(~840 MB download, ~4.9 GB extracted), or point JLCPCB_PARTS_DB at an existing copy.`,
      );
    }
    this.db = new sqlite.DatabaseSync(opts.dbPath, { readOnly: true });
  }

  /** Free-text search over the FTS index; short tokens fall back to LIKE. */
  searchComponents(opts: SearchOptions): Promise<Part[]> {
    return Promise.resolve(this.searchComponentsSync(opts));
  }

  /** Parametric resistor search — value verified from part data before returning. */
  searchResistors(opts: ResistorSearchOptions): Promise<Part[]> {
    return Promise.resolve(this.searchResistorsSync(opts));
  }

  /** Parametric capacitor search — value verified from part data before returning. */
  searchCapacitors(opts: CapacitorSearchOptions): Promise<Part[]> {
    return Promise.resolve(this.searchCapacitorsSync(opts));
  }

  /** Exact LCSC lookup through the FTS index (equality alone = 1.2s full scan). */
  getPart(lcsc: string | number): Promise<Part | null> {
    return Promise.resolve(this.getPartSync(lcsc));
  }

  /** Like getPart, but only when the part belongs to the matching category. */
  getPassiveDetail(lcsc: string | number, kind: "resistor" | "capacitor"): Promise<Part | null> {
    const part = this.getPartSync(lcsc);
    if (!part) return Promise.resolve(null);
    const want = kind === "resistor" ? "Resistors" : "Capacitors";
    return Promise.resolve(part.category === want ? part : null);
  }

  listCategories(): Promise<{ category: string; subcategory: string }[]> {
    const rows = this.prepare(
      `SELECT "First Category" AS category, "Second Category" AS subcategory FROM categories ` +
        `WHERE "First Category" <> '' OR "Second Category" <> '' ORDER BY 1, 2`,
    ).all() as { category: string; subcategory: string }[];
    return Promise.resolve(rows.map((r) => ({ category: str(r.category), subcategory: str(r.subcategory) })));
  }

  close(): void {
    this.stmts.clear();
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Sync implementations
  // -------------------------------------------------------------------------

  private prepare(sql: string): StatementSync {
    let stmt = this.stmts.get(sql);
    if (stmt === undefined) {
      stmt = this.db.prepare(sql);
      this.stmts.set(sql, stmt);
    }
    return stmt;
  }

  private queryParts(sql: string, params: (string | number)[]): Part[] {
    const rows = this.prepare(sql).all(...params) as Record<string, unknown>[];
    const parts: Part[] = [];
    for (const row of rows) {
      const part = normalizeDbRow(row);
      if (part) parts.push(part);
    }
    return parts;
  }

  private searchComponentsSync(opts: SearchOptions): Part[] {
    const limit = clampLimit(opts.limit);
    const q = opts.q?.trim() ?? "";
    const tokens = q === "" ? [] : q.split(/\s+/);
    const ftsTokens = tokens.filter(canTrigram);
    const likeTokens = tokens.filter((t) => !canTrigram(t));
    const pkg = opts.package?.trim();

    const matchTerms = ftsTokens.map(ftsPhrase);
    // Package rides the FTS index too, then is pinned exactly below (trigram
    // "0603" also matches "0603x4").
    if (pkg && canTrigram(pkg)) matchTerms.push(`Package:${ftsPhrase(pkg)}`);

    const where: string[] = [];
    const params: (string | number)[] = [];
    if (matchTerms.length > 0) {
      where.push("parts MATCH ?");
      params.push(matchTerms.join(" AND "));
    }
    for (const t of likeTokens) {
      where.push(`${LIKE_HAYSTACK} LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLike(t)}%`);
    }
    if (pkg) {
      where.push(`"Package" = ? COLLATE NOCASE`);
      params.push(pkg);
    }
    if (opts.minStock !== undefined && opts.minStock > 0) {
      where.push(`CAST("Stock" AS INTEGER) >= ?`);
      params.push(Math.floor(opts.minStock));
    }
    // Same semantics as JlcClient.tierMatches: "basic" (and "preferred", which
    // this DB cannot represent) restricts to Basic; "extended" = no restriction.
    if (opts.tier === "basic" || opts.tier === "preferred") {
      where.push(`"Library Type" = 'Basic'`);
    }
    if (where.length === 0) return [];

    const hasMatch = matchTerms.length > 0;
    // Without MATCH this is a full scan — omit ORDER BY so SQLite can stop at
    // LIMIT; results are then stock-sorted client-side (documented trade-off).
    // Basic parts first so the fee-free candidates always survive the LIMIT
    // (the engine ranks tier > stock, but can only rank rows we return).
    const sql =
      `SELECT * FROM parts WHERE ${where.join(" AND ")}` +
      (hasMatch ? ` ORDER BY ("Library Type" = 'Basic') DESC, CAST("Stock" AS INTEGER) DESC` : "") +
      ` LIMIT ?`;
    params.push(limit);
    const parts = this.queryParts(sql, params);
    if (!hasMatch) parts.sort((a, b) => b.stock - a.stock);
    return parts;
  }

  private searchResistorsSync(opts: ResistorSearchOptions): Part[] {
    const limit = clampLimit(opts.limit);
    const parts = this.parametricFetch("Resistors", resistanceVariants(opts.ohms), opts.package, limit);
    const out: Part[] = [];
    for (const part of parts) {
      if (opts.ohms !== undefined) {
        const ohms = readResistance(part);
        // Never return unverified-value rows from parametric search.
        if (ohms === undefined || !relEqual(ohms, opts.ohms, 0.005)) continue;
      }
      if (opts.maxTolerance !== undefined) {
        const tolPct = readTolerancePct(part);
        // Unknown tolerance is kept (cannot disprove) — parity with JlcClient.
        if (tolPct !== undefined && tolPct / 100 > opts.maxTolerance * (1 + 1e-9)) continue;
      }
      out.push(part);
      if (out.length >= limit) break;
    }
    return out;
  }

  private searchCapacitorsSync(opts: CapacitorSearchOptions): Part[] {
    const limit = clampLimit(opts.limit);
    const parts = this.parametricFetch("Capacitors", capacitanceVariants(opts.farads), opts.package, limit);
    const out: Part[] = [];
    for (const part of parts) {
      if (opts.farads !== undefined) {
        const farads = readCapacitance(part);
        // Never return unverified-value rows from parametric search.
        if (farads === undefined || !relEqual(farads, opts.farads, 0.05)) continue;
      }
      if (opts.minVoltage !== undefined) {
        const rating = readVoltage(part);
        // Unknown voltage rating is kept (cannot disprove) — only drop known-bad.
        if (rating !== undefined && rating < opts.minVoltage) continue;
      }
      out.push(part);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Shared parametric query: category (FTS + exact pin) + optional value
   * variants (ORed phrases) + optional package (FTS + exact pin), stock-sorted.
   * Fetches limit×10 (min 200) rows of headroom because trigram substring
   * matches include wrong values ("10kΩ" ⊂ "510kΩ") that verification drops.
   */
  private parametricFetch(
    category: "Resistors" | "Capacitors",
    valueVariants: string[],
    pkgRaw: string | undefined,
    limit: number,
  ): Part[] {
    const matchTerms = [`"First Category": ${ftsPhrase(category)}`];
    if (valueVariants.length > 0) {
      matchTerms.push(`(${valueVariants.map(ftsPhrase).join(" OR ")})`);
    }
    const pkg = pkgRaw?.trim();
    if (pkg && canTrigram(pkg)) matchTerms.push(`Package:${ftsPhrase(pkg)}`);

    const where = ["parts MATCH ?", `"First Category" = ?`];
    const params: (string | number)[] = [matchTerms.join(" AND "), category];
    if (pkg) {
      where.push(`"Package" = ? COLLATE NOCASE`);
      params.push(pkg);
    }
    const fetchLimit = Math.min(VERIFY_FETCH_MAX, Math.max(VERIFY_FETCH_MIN, limit * 10));
    params.push(fetchLimit);
    const sql =
      `SELECT * FROM parts WHERE ${where.join(" AND ")} ` +
      `ORDER BY ("Library Type" = 'Basic') DESC, CAST("Stock" AS INTEGER) DESC LIMIT ?`;
    return this.queryParts(sql, params);
  }

  private getPartSync(lcsc: string | number): Part | null {
    const id = toLcscId(lcsc);
    const canonical = `C${id}`;
    if (!canTrigram(canonical)) {
      // Sub-3-char LCSC ids ("C5") cannot ride the trigram index — rare, so a
      // (slow) equality scan is acceptable for correctness.
      const parts = this.queryParts(`SELECT * FROM parts WHERE "LCSC Part" = ? LIMIT 1`, [canonical]);
      return parts[0] ?? null;
    }
    // MATCH narrows via the index; the equality pins away substring matches
    // (MATCH 'C25804' alone also returns C2580400 — verified in the notes).
    const parts = this.queryParts(
      `SELECT * FROM parts WHERE parts MATCH ? AND "LCSC Part" = ? LIMIT 1`,
      [`"LCSC Part": ${ftsPhrase(canonical)}`, canonical],
    );
    return parts[0] ?? null;
  }
}

// ---------------------------------------------------------------------------
// Row normalization
// ---------------------------------------------------------------------------

/** Columns concatenated for the LIKE fallback on sub-trigram tokens. */
const LIKE_HAYSTACK =
  `("LCSC Part" || ' ' || "MFR.Part" || ' ' || "Package" || ' ' || "Manufacturer" || ' ' || "Description")`;

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** One malformed row must not sink a result set → null instead of throwing. */
function normalizeDbRow(row: Record<string, unknown>): Part | null {
  let lcscId: number;
  try {
    lcscId = toLcscId(str(row["LCSC Part"]));
  } catch {
    return null;
  }
  const category = str(row["First Category"]);
  const subcategory = str(row["Second Category"]);
  const description = str(row["Description"]);
  const tier: PartTier = str(row["Library Type"]) === "Basic" ? "basic" : "extended";
  const priceBreaks = parseDbPriceBreaks(str(row["Price"]));
  const stockNum = Number(str(row["Stock"]));
  const attributes = extractAttributes({
    category,
    description,
    manufacturer: str(row["Manufacturer"]),
    datasheet: str(row["Datasheet"]),
    tier,
  });

  const part: Part = {
    lcsc: `C${lcscId}`,
    lcscId,
    mfr: str(row["MFR.Part"]),
    description,
    package: str(row["Package"]),
    stock: Number.isFinite(stockNum) && stockNum > 0 ? Math.floor(stockNum) : 0,
    tier,
    priceBreaks,
    unitPrice: priceBreaks.length > 0 ? priceBreaks[0].price : null,
    productUrl: `https://jlcpcb.com/partdetail/C${lcscId}`,
  };
  if (category !== "") part.category = category;
  if (subcategory !== "") part.subcategory = subcategory;
  if (attributes !== undefined) part.attributes = attributes;
  return part;
}

/**
 * Parse the DB's "Price" TEXT format: comma-joined "qFrom-qTo:price" tiers,
 * open-ended last tier with empty qTo ("1-:0.003", "...,5000-:0.074").
 * Empty for 89% of rows; garbage segments are skipped defensively.
 */
export function parseDbPriceBreaks(text: string): PriceBreak[] {
  if (text.trim() === "") return [];
  const breaks: PriceBreak[] = [];
  for (const seg of text.split(",")) {
    const m = /^\s*(\d+)\s*-\s*(\d*)\s*:\s*(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*$/.exec(seg);
    if (!m) continue;
    const price = Number(m[3]);
    if (!Number.isFinite(price) || price < 0) continue;
    const qFrom = Number(m[1]);
    breaks.push({
      qFrom: Number.isFinite(qFrom) && qFrom >= 1 ? qFrom : 1,
      qTo: m[2] === "" ? null : Number(m[2]),
      price,
    });
  }
  breaks.sort((a, b) => a.qFrom - b.qFrom);
  return breaks;
}

/**
 * Description → attributes, gated by category so an LED's "1.8V~2.4V" never
 * becomes a resistance. Keys match what src/engine/rank.ts's readers look for
 * (Resistance/Capacitance/Tolerance) so hard filters can verify specs.
 */
function extractAttributes(input: {
  category: string;
  description: string;
  manufacturer: string;
  datasheet: string;
  tier: PartTier;
}): Record<string, string> | undefined {
  const attrs: Record<string, string> = {};
  const isResistor = input.category === "Resistors";
  const isCapacitor = input.category === "Capacitors";
  if (isResistor) {
    const m = RES_DESC_RE.exec(input.description);
    if (m) attrs.Resistance = `${m[1]}${m[2] ?? ""}Ω`;
  }
  if (isCapacitor) {
    const m = CAP_DESC_RE.exec(input.description);
    if (m) attrs.Capacitance = `${m[1]}${m[2]}F`;
  }
  if (isResistor || isCapacitor) {
    const tol = TOL_RE.exec(input.description);
    if (tol) attrs.Tolerance = `±${tol[1]}%`;
    const volt = VOLT_RE.exec(input.description);
    if (volt) attrs["Voltage Rated"] = `${volt[1]}${volt[2] ? "k" : ""}V`;
  }
  if (input.manufacturer !== "") attrs.Manufacturer = input.manufacturer;
  if (input.datasheet !== "") attrs.Datasheet = input.datasheet;
  if (input.tier === "extended") attrs["Tier Note"] = TIER_NOTE;
  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

// ---------------------------------------------------------------------------
// FTS query building
// ---------------------------------------------------------------------------

/** Trigram tokens under 3 code points return 0 rows silently. */
function canTrigram(token: string): boolean {
  return [...token].length >= 3;
}

/** Quote a user token as an FTS5 string: neutralizes AND/OR/:/-/( metachars. */
function ftsPhrase(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

function escapeLike(t: string): string {
  return t.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function clampLimit(limit: number | undefined): number {
  const v = limit ?? DEFAULT_LIMIT;
  return Number.isFinite(v) ? Math.max(1, Math.floor(v)) : DEFAULT_LIMIT;
}

function trimNum(n: number): string {
  return String(Number(n.toFixed(3)));
}

/** 10000 → ["10kΩ", "10k"]; 470 → ["470Ω", "470"]; 47 → ["47Ω"]. */
function resistanceVariants(ohms: number | undefined): string[] {
  if (ohms === undefined) return [];
  let scaled: number;
  let suffix: string;
  if (ohms >= 1e6) {
    scaled = ohms / 1e6;
    suffix = "M";
  } else if (ohms >= 1e3) {
    scaled = ohms / 1e3;
    suffix = "k";
  } else if (ohms >= 1) {
    scaled = ohms;
    suffix = "";
  } else {
    scaled = ohms * 1e3;
    suffix = "m";
  }
  const num = trimNum(scaled);
  return [`${num}${suffix}Ω`, `${num}${suffix}`].filter(canTrigram);
}

/** 1e-7 → ["100nF", "0.1uF", "0.1µF"]; 4.7e-6 → ["4.7uF", "4.7µF"]. */
function capacitanceVariants(farads: number | undefined): string[] {
  if (farads === undefined) return [];
  const out: string[] = [];
  if (farads >= 1e-6) {
    const uf = trimNum(farads * 1e6);
    out.push(`${uf}uF`, `${uf}µF`);
  } else if (farads >= 1e-9) {
    out.push(`${trimNum(farads * 1e9)}nF`);
    const uf = trimNum(farads * 1e6);
    out.push(`${uf}uF`, `${uf}µF`);
  } else {
    out.push(`${trimNum(farads * 1e12)}pF`);
  }
  return out.filter(canTrigram);
}

// ---------------------------------------------------------------------------
// Spec verification readers (attribute first, then raw description)
// ---------------------------------------------------------------------------

function relEqual(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b)) + Number.EPSILON;
}

function readResistance(part: Part): number | undefined {
  const m = RES_DESC_RE.exec(part.attributes?.Resistance ?? part.description);
  if (!m) return undefined;
  return Number(m[1]) * (m[2] ? RES_MULT[m[2]] : 1);
}

function readCapacitance(part: Part): number | undefined {
  const m = CAP_DESC_RE.exec(part.attributes?.Capacitance ?? part.description);
  if (!m) return undefined;
  return Number(m[1]) * CAP_MULT[m[2]];
}

function readTolerancePct(part: Part): number | undefined {
  const m = TOL_RE.exec(part.attributes?.Tolerance ?? part.description);
  return m ? Number(m[1]) : undefined;
}

function readVoltage(part: Part): number | undefined {
  const m = VOLT_RE.exec(part.attributes?.["Voltage Rated"] ?? part.description);
  if (!m) return undefined;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return undefined;
  return m[2] ? v * 1000 : v;
}
