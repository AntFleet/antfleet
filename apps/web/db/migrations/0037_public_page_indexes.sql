-- Migration 0037: public-page index coverage.
--
-- /receipts and /receipts.rss join finding_status -> reviews filtering on
-- status='closed' AND public_receipt=true. Without these indexes the joins
-- fall back to seq scans as the corpus grows. Operator applies via
-- apps/web/db/migrations/apply-migration-0037.ts (NOT YET CREATED; this
-- migration is data-only and uses IF NOT EXISTS so it can be applied via
-- psql or the standard drizzle-kit migrate flow). All three CREATE INDEX
-- statements are idempotent.

CREATE INDEX IF NOT EXISTS finding_status_review_id_idx
  ON finding_status (review_id);

CREATE INDEX IF NOT EXISTS finding_status_status_closure_idx
  ON finding_status (status, closure_detected_at);

CREATE INDEX IF NOT EXISTS reviews_public_receipt_idx
  ON reviews (public_receipt);
