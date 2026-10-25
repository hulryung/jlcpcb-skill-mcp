-- Indexes that scripts/build-d1-db.ts creates locally but that are missing from
-- the live D1 database (sqlite_master shows only the lcsc autoindex). Apply once:
--   cd worker && npx wrangler d1 execute jlcpcb-parts --remote --file migrations/0001-indexes.sql --yes
-- Building each index reads the whole table (~693k rows × 3 ≈ 2.1M billed reads),
-- so run it on a day with free-plan read headroom, not right after a quota warning.
CREATE INDEX IF NOT EXISTS ix_pkg ON parts(package);
CREATE INDEX IF NOT EXISTS ix_cat ON parts(category);
CREATE INDEX IF NOT EXISTS ix_stock ON parts(stock);
