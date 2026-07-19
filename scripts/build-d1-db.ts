/**
 * Build a lean SQLite DB (+ SQL dump) for Cloudflare D1 from the full local DB.
 *
 * The upstream DB (~4.9 GiB, 7.1M rows, trigram FTS) is a full catalog dump
 * where 90% of rows are out of stock. A part-suggestion tool hard-filters
 * stock <= 0, so we keep only in-stock rows (~693k) and normalize into a plain
 * indexed table + a light FTS5 (unicode61) over the searchable text. Result is
 * ~340 MB — inside the D1 free-plan limit (500 MB) and cheap to query.
 *
 *   npm run build:d1-db [-- --src <path>] [--out <path>] [--dump]
 *
 * Defaults: reads ~/.cache/jlcpcb-parts/parts-fts5.db, writes parts-d1.db
 * (and parts-d1.sql when --dump) beside it.
 */
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { statSync, rmSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const wantDump = args.includes("--dump");

const cacheDir = process.env.XDG_CACHE_HOME
  ? join(process.env.XDG_CACHE_HOME, "jlcpcb-parts")
  : join(homedir(), ".cache", "jlcpcb-parts");
const src = flag("src", join(cacheDir, "parts-fts5.db"))!;
const out = flag("out", join(cacheDir, "parts-d1.db"))!;
const dumpPath = out.replace(/\.db$/, "") + ".sql";

if (!existsSync(src)) {
  console.error(`Source DB not found: ${src}\nRun \`npm run db:update\` first.`);
  process.exit(1);
}
if (existsSync(out)) rmSync(out);

const mb = (b: number) => (b / 1024 / 1024).toFixed(1) + " MB";
console.log(`Source: ${src} (${mb(statSync(src).size)})`);
console.log(`Output: ${out}`);

const t0 = Date.now();
const db = new DatabaseSync(out);
db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;");
// Plain, indexed table — fast exact filters, no trigram bloat. Column names are
// clean snake_case; the D1 Worker's query builder targets exactly these.
db.exec(`CREATE TABLE parts(
  lcsc TEXT PRIMARY KEY,
  mfr TEXT, package TEXT, category TEXT, subcategory TEXT,
  manufacturer TEXT, library_type TEXT, description TEXT,
  price TEXT, stock INTEGER, datasheet TEXT)`);

db.exec(`ATTACH DATABASE '${src.replace(/'/g, "''")}' AS full`);
console.log("Copying in-stock rows (Stock > 0)…");
db.exec(`INSERT OR IGNORE INTO parts SELECT
  "LCSC Part","MFR.Part","Package","First Category","Second Category",
  "Manufacturer","Library Type","Description","Price",
  CAST("Stock" AS INTEGER),"Datasheet"
  FROM full.parts WHERE CAST("Stock" AS INTEGER) > 0`);
db.exec("DETACH DATABASE full");

db.exec(`CREATE INDEX ix_pkg ON parts(package)`);
db.exec(`CREATE INDEX ix_cat ON parts(category)`);
db.exec(`CREATE INDEX ix_stock ON parts(stock)`);
// Standalone FTS5 (not external-content) so `.dump` round-trips cleanly into D1.
db.exec(`CREATE VIRTUAL TABLE parts_fts USING fts5(
  lcsc, mfr, description, manufacturer, content='parts', content_rowid='rowid')`);
db.exec(`INSERT INTO parts_fts(rowid, lcsc, mfr, description, manufacturer)
  SELECT rowid, lcsc, mfr, description, manufacturer FROM parts`);

const n = (db.prepare(`SELECT COUNT(*) c FROM parts`).get() as { c: number }).c;
console.log(`Inserted ${n.toLocaleString()} rows`);
for (const lcsc of ["C25804", "C7593", "C2286"]) {
  const r = db.prepare(`SELECT stock FROM parts WHERE lcsc = ?`).get(lcsc) as
    | { stock: number }
    | undefined;
  console.log(`  ${lcsc}: ${r ? "stock " + r.stock : "MISSING"}`);
}
db.exec(`INSERT INTO parts_fts(parts_fts) VALUES('optimize')`);
db.exec("VACUUM");
db.close();

const size = statSync(out).size;
console.log(`Built ${out} (${mb(size)}) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(
  size < 500 * 1024 * 1024
    ? "→ fits the Cloudflare D1 free plan (500 MB)."
    : "→ over the D1 free plan (500 MB); needs the paid plan (10 GB) or more trimming.",
);

if (wantDump) {
  console.log(`Writing SQL dump → ${dumpPath} (for \`wrangler d1 import\`)…`);
  const res = spawnSync("sqlite3", [out, `.output ${dumpPath}`, ".dump", ".exit"], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    console.error("sqlite3 .dump failed (is the sqlite3 CLI installed?):", res.stderr);
    process.exit(1);
  }
  console.log(`Dump: ${dumpPath} (${mb(statSync(dumpPath).size)})`);
  console.log("Import with:  wrangler d1 import <DB_NAME> --file=" + dumpPath);
}
