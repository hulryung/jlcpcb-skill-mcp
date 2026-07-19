/**
 * Download / update the JLCPCB parts FTS5 SQLite database.
 *
 * Source: https://bouni.github.io/kicad-jlcpcb-tools/ publishes the DB as a
 * split zip — chunk count in chunk_num_fts5.txt, chunks named
 * parts-fts5.db.zip.001 … .0NN (~76 MB each, ~840 MB total). Concatenating all
 * chunks yields one .zip containing parts-fts5.db (an FTS5 table "parts").
 *
 * Usage:
 *   npm run db:update                 # skip if cached DB is < 7 days old
 *   npm run db:update -- --force      # always re-download
 *   npm run db:update -- --dir /path  # override target directory
 *
 * Default target dir: ${XDG_CACHE_HOME:-~/.cache}/jlcpcb-parts/
 * Writes: parts-fts5.db + meta.json {downloadedAt, chunks, bytes, source}
 */
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";

const SOURCE_BASE = "https://bouni.github.io/kicad-jlcpcb-tools";
const DB_NAME = "parts-fts5.db";
const ZIP_NAME = "parts-fts5.db.zip";
const MAX_AGE_DAYS = 7;
/** A real chunk is ~76 MB; anything under this is a truncated/error response. */
const MIN_CHUNK_BYTES = 1024 * 1024;

interface Meta {
  downloadedAt: string;
  chunks: number;
  bytes: number;
  source: string;
}

function defaultTargetDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const cacheRoot = xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".cache");
  return join(cacheRoot, "jlcpcb-parts");
}

function parseArgs(argv: string[]): { dir: string; force: boolean } {
  let dir = defaultTargetDir();
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") force = true;
    else if (a === "--dir") {
      const v = argv[++i];
      if (!v) fail("--dir requires a path argument");
      dir = resolve(v);
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: tsx scripts/update-db.ts [--dir <path>] [--force]");
      process.exit(0);
    } else fail(`Unknown argument: ${a}`);
  }
  return { dir, force };
}

function fail(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

function fmtBytes(n: number): string {
  return n >= 1024 * 1024
    ? `${(n / (1024 * 1024)).toFixed(1)} MB`
    : `${(n / 1024).toFixed(1)} KB`;
}

/** Download url → destPath via temp file + atomic rename. Returns byte count. */
async function downloadFile(url: string, destPath: string): Promise<number> {
  const tmpPath = `${destPath}.part`;
  const res = await fetch(url);
  if (res.status !== 200 || !res.body) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  await pipeline(
    Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
    createWriteStream(tmpPath),
  );
  const size = await fileSize(tmpPath);
  if (size === null || size < MIN_CHUNK_BYTES) {
    await rm(tmpPath, { force: true });
    throw new Error(`Chunk too small (${size ?? 0} bytes) from ${url} — truncated download?`);
  }
  await rename(tmpPath, destPath);
  return size;
}

async function fetchChunkCount(): Promise<number> {
  const url = `${SOURCE_BASE}/chunk_num_fts5.txt`;
  const res = await fetch(url);
  if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${url}`);
  const n = Number.parseInt((await res.text()).trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new Error(`Implausible chunk count "${n}" from ${url}`);
  }
  return n;
}

function checkUnzip(): void {
  const probe = spawnSync("unzip", ["-v"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    fail(
      `"unzip" is not available on PATH — install it (macOS: preinstalled; ` +
        `Debian/Ubuntu: apt install unzip) and re-run.`,
    );
  }
}

async function concatChunks(chunkPaths: string[], zipPath: string): Promise<number> {
  const out = createWriteStream(zipPath);
  let total = 0;
  for (const p of chunkPaths) {
    const data = await readFile(p);
    total += data.length;
    await new Promise<void>((resolvePromise, reject) => {
      out.write(data, (err) => (err ? reject(err) : resolvePromise()));
    });
  }
  await new Promise<void>((resolvePromise, reject) => {
    out.end((err?: Error | null) => (err ? reject(err) : resolvePromise()));
  });
  return total;
}

function verifyDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string; sql: string | null }[];
    if (!tables.some((t) => t.name === "parts")) {
      fail(
        `Extracted DB has no "parts" table. Tables found: ` +
          `${tables.map((t) => t.name).join(", ") || "(none)"}`,
      );
    }
    console.log("\nSchema (sqlite_master):");
    for (const t of tables) console.log(`  ${t.sql ?? `[virtual] ${t.name}`}`);
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM parts").get() as { n: number };
    console.log(`\nRow count of "parts": ${n.toLocaleString("en-US")}`);
    if (n < 1000) fail(`Suspiciously few rows (${n}) in parts table`);
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const { dir, force } = parseArgs(process.argv.slice(2));
  const dbPath = join(dir, DB_NAME);
  const metaPath = join(dir, "meta.json");

  // Freshness check
  if (!force && (await fileSize(dbPath)) !== null) {
    try {
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as Meta;
      const ageMs = Date.now() - Date.parse(meta.downloadedAt);
      const ageDays = ageMs / 86_400_000;
      if (Number.isFinite(ageDays) && ageDays >= 0 && ageDays < MAX_AGE_DAYS) {
        console.log(
          `Parts DB at ${dbPath} is ${ageDays.toFixed(1)} days old ` +
            `(< ${MAX_AGE_DAYS} days) — skipping download. Use --force to re-download.`,
        );
        return;
      }
      console.log(`Cached DB is ${ageDays.toFixed(1)} days old — refreshing.`);
    } catch {
      console.log("DB exists but meta.json is missing/unreadable — re-downloading.");
    }
  }

  checkUnzip();
  await mkdir(dir, { recursive: true });
  const tmpDir = join(dir, ".tmp-download");
  await mkdir(tmpDir, { recursive: true });

  const chunkCount = await fetchChunkCount();
  console.log(`Source: ${SOURCE_BASE} — ${chunkCount} chunks`);

  // Download chunks sequentially (skip chunks already fully present in tmpDir)
  const chunkPaths: string[] = [];
  let totalBytes = 0;
  for (let i = 1; i <= chunkCount; i++) {
    const name = `${ZIP_NAME}.${String(i).padStart(3, "0")}`;
    const dest = join(tmpDir, name);
    const existing = await fileSize(dest);
    let bytes: number;
    if (existing !== null && existing >= MIN_CHUNK_BYTES && !force) {
      bytes = existing;
      console.log(`[${i}/${chunkCount}] ${name}  ${fmtBytes(bytes)} (already downloaded, kept)`);
    } else {
      const t0 = Date.now();
      bytes = await downloadFile(`${SOURCE_BASE}/${name}`, dest);
      const secs = (Date.now() - t0) / 1000;
      console.log(
        `[${i}/${chunkCount}] ${name}  ${fmtBytes(bytes)} in ${secs.toFixed(1)}s ` +
          `(${fmtBytes(bytes / Math.max(secs, 0.001))}/s)`,
      );
    }
    totalBytes += bytes;
    chunkPaths.push(dest);
  }

  // Concatenate chunks → single zip
  const zipPath = join(tmpDir, ZIP_NAME);
  console.log(`Concatenating ${chunkCount} chunks → ${ZIP_NAME} (${fmtBytes(totalBytes)})`);
  await concatChunks(chunkPaths, zipPath);

  // Extract
  const extractDir = join(tmpDir, "extract");
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  console.log("Extracting with unzip -o …");
  const unzip = spawnSync("unzip", ["-o", zipPath, "-d", extractDir], { stdio: "inherit" });
  if (unzip.error || unzip.status !== 0) {
    fail(
      `unzip failed (exit ${unzip.status ?? "?"}) — the concatenated zip may be ` +
        `corrupt. Delete ${tmpDir} and re-run with --force.`,
    );
  }

  // Locate the extracted DB file
  const extracted = await readdir(extractDir);
  const dbFile =
    extracted.find((f) => f === DB_NAME) ?? extracted.find((f) => f.endsWith(".db"));
  if (!dbFile) {
    fail(`No .db file found after extraction. Zip contents: ${extracted.join(", ")}`);
  }
  const extractedPath = join(extractDir, dbFile);
  const dbBytes = (await fileSize(extractedPath)) ?? 0;

  // Atomic move into place (same filesystem — tmpDir lives inside target dir)
  await rename(extractedPath, dbPath);
  const meta: Meta = {
    downloadedAt: new Date().toISOString(),
    chunks: chunkCount,
    bytes: totalBytes,
    source: SOURCE_BASE,
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
  console.log(`Installed ${dbPath} (${fmtBytes(dbBytes)}); wrote ${metaPath}`);

  // Clean up chunk/zip temp files on success
  await rm(tmpDir, { recursive: true, force: true });

  // Verify
  verifyDb(dbPath);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
