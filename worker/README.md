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

## Refreshing the catalog

Re-run steps 1 and 3. On the free plan (~3M writes/month) a full re-import is
~1.4M writes, so a couple of refreshes a month fits — the catalog changes
slowly, and `/part/<lcsc>` already proxies live jlcsearch for fresh stock and
the preferred-tier flag on the parts you actually pick.

## Notes / limitations

- The catalog DB distinguishes only **Basic vs Extended** (no Preferred). Search
  results carry Basic/Extended; `/part/<lcsc>` proxies live jlcsearch to recover
  fresh stock + the preferred flag on final picks.
- If a future catalog grows past the free-plan 500 MB, either move to the D1 paid
  plan (10 GB) or self-host the full `node:sqlite` server behind a Cloudflare
  Tunnel (reuses `JlcDbClient`, no import step) — see the repo's local DB docs.
