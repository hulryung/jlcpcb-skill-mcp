# jlcpcb-parts-api — Cloudflare Worker (D1)

Serves the JLCPCB catalog from D1 so teammates get catalog search with **no
local download**. Returns the project's `Part` JSON; the MCP server consumes it
by setting `JLCPCB_API_URL` (see below).

The trimmed in-stock catalog is ~347 MB / ~693k parts — inside the **D1 free
plan** (500 MB per database).

## One-time deploy

From the repo root, after `npm run db:update` (builds the full local DB):

```bash
# 1. Build the trimmed D1 database + SQL dump (~347 MB db, ~410 MB dump)
npm run build:d1-db -- --dump

# 2. Log in and create the D1 database
npx wrangler login
npx wrangler d1 create jlcpcb-parts
#   → paste the printed database_id into worker/wrangler.jsonc

# 3. Import the catalog (validate with a small slice first if you like)
npx wrangler d1 import jlcpcb-parts --file ~/.cache/jlcpcb-parts/parts-d1.sql

# 4. Deploy the Worker
cd worker && npx wrangler deploy
#   → prints https://jlcpcb-parts-api.<subdomain>.workers.dev
```

Quick check:

```bash
curl https://jlcpcb-parts-api.<subdomain>.workers.dev/health
curl "https://jlcpcb-parts-api.<subdomain>.workers.dev/resistors?ohms=10000&package=0603&limit=3"
```

## Point the MCP server at it

Teammates need no DB download — just the URL:

```bash
JLCPCB_API_URL=https://jlcpcb-parts-api.<subdomain>.workers.dev
```

Set it in the MCP registration env, e.g.:

```bash
claude mcp add --scope user jlcpcb-parts \
  -e JLCPCB_API_URL=https://jlcpcb-parts-api.<subdomain>.workers.dev \
  -- node /path/to/jlcpcb-skill-mcp/dist/index.js
```

The server's data-source priority is: local DB (if present) → `JLCPCB_API_URL` →
live jlcsearch. So the hosted API is used only when no local DB exists.

## Refreshing the catalog

`build:d1-db` again, then re-import. On the free plan (~3M writes/month), a full
re-import (~1.4M writes) fits roughly a couple of times a month — the catalog
changes slowly, and `/part/<lcsc>` already proxies live jlcsearch for fresh
stock and the preferred-tier flag on the parts you actually pick.

## Notes / limitations

- The catalog DB distinguishes only **Basic vs Extended** (no Preferred). The
  Worker's `/part/<lcsc>` proxies live jlcsearch to recover fresh stock + the
  preferred flag; search results carry Basic/Extended only.
- Endpoints: `/health`, `/search`, `/resistors`, `/capacitors`,
  `/part/<lcsc>`, `/passive/<kind>/<lcsc>`, `/categories`.
- If the ~410 MB import is unwieldy on your connection, import in slices with
  `wrangler d1 execute --file` chunks, or fall back to self-hosting the full
  node:sqlite server behind a Cloudflare Tunnel (see the repo's local DB docs).
