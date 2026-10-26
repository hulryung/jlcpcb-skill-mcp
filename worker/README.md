# jlcpcb-parts-api — Cloudflare Worker (D1)

Serves the JLCPCB catalog from D1 so teammates get catalog search with **no
local download**. Returns the project's `Part` JSON; the MCP server consumes it
by setting `JLCPCB_API_URL` (see below).

**Live instance:** `https://jlcpcb-parts-api.dkkang7484.workers.dev`
(692,802 in-stock parts; ~330 MB in D1, inside the free-plan 500 MB limit.)

## Endpoints

`/health` · `/search?q&package&tier&min_stock&limit` ·
`/resistors?ohms&package&limit` · `/capacitors?farads&package&limit` ·
`/part/<lcsc>` (proxies live jlcsearch for fresh stock + preferred tier) ·
`/passive/<kind>/<lcsc>` · `/categories`

`/health` returns `{ ok: true }` (no row count — see "Read budget").

```bash
curl https://jlcpcb-parts-api.dkkang7484.workers.dev/health
curl "https://jlcpcb-parts-api.dkkang7484.workers.dev/resistors?ohms=10000&package=0603&limit=3"
```

## Point the MCP server at it (teammates — no DB download)

```bash
claude mcp add --scope user jlcpcb-parts \
  -e JLCPCB_API_URL=https://jlcpcb-parts-api.dkkang7484.workers.dev \
  -- node /path/to/jlcpcb-skill-mcp/dist/index.js
```

Data-source priority is: local DB (if present) → `JLCPCB_API_URL` → live
jlcsearch. So the hosted API is used only when no local DB exists.

## Deploy / redeploy from scratch

From the repo root, after `npm run db:update` (builds the full local DB):

```bash
# 1. Build the trimmed in-stock DB + split SQL (parts dump + separate FTS setup)
npm run build:d1-db -- --dump
#   → ~/.cache/jlcpcb-parts/parts-d1.sql (parts table, ~242 MB)
#     ~/.cache/jlcpcb-parts/parts-d1-fts.sql (creates + rebuilds the FTS index)

# 2. Auth + create the database (once)
npx wrangler login
npx wrangler d1 create jlcpcb-parts       # paste the id into wrangler.jsonc

# 3. Import — this wrangler uses `d1 execute --file`, not `d1 import`.
#    Reset first if re-importing over existing data:
cd worker
npx wrangler d1 execute jlcpcb-parts --remote \
  --command "DROP TABLE IF EXISTS parts_fts; DROP TABLE IF EXISTS parts;" --yes
npx wrangler d1 execute jlcpcb-parts --remote --file ~/.cache/jlcpcb-parts/parts-d1.sql --yes      # ~44s
npx wrangler d1 execute jlcpcb-parts --remote --file ~/.cache/jlcpcb-parts/parts-d1-fts.sql --yes  # ~11s

# 4. Deploy the Worker
npx wrangler deploy
```

Validate cheaply first with a 5k-row slice:
`npm run build:d1-db -- --slice 5000 --out ~/.cache/jlcpcb-parts/parts-d1-slice.db --dump`,
then the same execute/deploy against `parts-d1-slice.sql`.

The build step strips `BEGIN TRANSACTION`/`COMMIT`/`PRAGMA` (D1 rejects them)
and the FTS shadow tables from the parts dump; the FTS index is built
server-side afterward from the imported content table.

## Read budget (D1 free plan: 5M rows read / day)

On 2026-10-24 one afternoon of agent-driven searches read 3.77M rows (75% of
the daily budget) and Cloudflare sent a quota warning. Causes and the fixes now
in `src/index.ts`:

| Before | Rows read | Now |
|---|---|---|
| `/health` ran `SELECT COUNT(*)` | 692,802 per call (full scan) | `SELECT lcsc … LIMIT 1` → 1 row, returns `{ ok }` only |
| FTS `MATCH … JOIN parts ORDER BY stock LIMIT n` | every matched row (5k–70k for "10k", "0603") | FTS rowids capped at 20,000 before the join (`FTS_CANDIDATE_CAP`) — worst query ≈40k reads |
| `q` with no ≥3-char token (e.g. `q=1k`, package-only) fell back to `LIKE` / plain filter | full scan | returns `[]` — a search must narrow through FTS first |
| `/categories` `SELECT DISTINCT` | full scan per call | edge-cached for a day |
| every search hit D1 | — | `/search` `/resistors` `/capacitors` `/categories` `/passive/*` edge-cached 24h (catalog is a snapshot) |

Trade-off: capped candidates come back in rowid order, so a token matching
more than 20k rows may miss the highest-stock match. Typical queries match far
fewer rows and are unaffected; for passives prefer `/resistors` / `/capacitors`.
Note `package` is not an FTS column, so `q=10k 0603` finds nothing — pass
`package=0603` instead (that was already true before these changes).

`migrations/0001-indexes.sql` adds the `package`/`category`/`stock` indexes the
build script creates locally but the live DB lacked. Applied 2026-10-26: it cost
4.17M rows read **and 2.08M rows written** — every index entry is a billed
write, so it blew through the free plan's 100k writes/day and Cloudflare blocked
writes until the next 00:00 UTC reset. The API is read-only, so nothing broke,
but don't re-run it (it is `IF NOT EXISTS` anyway) and budget writes, not just
reads, for any future schema change.

## Refreshing the catalog

Re-run steps 1 and 3. A full re-import is ~1.4M rows written (more with the
three indexes), far over the free plan's 100k writes/day, so expect writes to be
blocked for the rest of that UTC day — reads keep working. The catalog changes
slowly, and `/part/<lcsc>` already proxies live jlcsearch for fresh stock and
the preferred-tier flag on the parts you actually pick.

## Notes / limitations

- The catalog DB distinguishes only **Basic vs Extended** (no Preferred). Search
  results carry Basic/Extended; `/part/<lcsc>` proxies live jlcsearch to recover
  fresh stock + the preferred flag on final picks.
- If a future catalog grows past the free-plan 500 MB, either move to the D1 paid
  plan (10 GB) or self-host the full `node:sqlite` server behind a Cloudflare
  Tunnel (reuses `JlcDbClient`, no import step) — see the repo's local DB docs.
