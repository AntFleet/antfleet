-- Migration 0047: record consumed SARIF ingest JTIs on import batches and
-- document the scheduled token-use GC.
--
-- The Vercel cron at /api/cron/sarif-token-use-gc runs hourly and deletes
-- sarif_ingest_token_use rows where used_at < now() - interval '1 hour'.
-- The one-hour retention is safely above the 5-minute token TTL while keeping
-- the replay-guard table bounded.

ALTER TABLE "sarif_import_batch"
  ADD COLUMN IF NOT EXISTS "ingest_token_jti" text;

CREATE INDEX IF NOT EXISTS "sarif_import_batch_ingest_token_jti_idx"
  ON "sarif_import_batch" ("ingest_token_jti");

COMMENT ON TABLE "sarif_ingest_token_use" IS
  'One-shot SARIF ingest replay guard; hourly Vercel cron purges rows older than one hour.';
