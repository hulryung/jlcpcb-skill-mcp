-- Indexes that scripts/build-d1-db.ts creates locally but that are missing from
-- the live D1 database (sqlite_master shows only the lcsc autoindex). Apply once:
--   cd worker && npx wrangler d1 execute jlcpcb-parts --remote --file migrations/0001-indexes.sql --yes
-- Applied 2026-10-26. Cost: 4.17M rows read and 2.08M rows written (each index
-- entry is a billed write) — over the free plan's 100k writes/day, so D1 blocked
-- writes until the next 00:00 UTC. Do not re-run casually.
CREATE INDEX IF NOT EXISTS ix_pkg ON parts(package);
CREATE INDEX IF NOT EXISTS ix_cat ON parts(category);
CREATE INDEX IF NOT EXISTS ix_stock ON parts(stock);
