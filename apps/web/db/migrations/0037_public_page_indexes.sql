-- Migration 0037: public-page index coverage.
--
-- /receipts and /receipts.rss join finding_status -> reviews filtering on
-- status='closed' AND public_receipt=true. Without these indexes the joins
-- fall back to seq scans as the corpus grows. Operator applies via
-- `pnpm exec tsx db/migrations/apply-migration-0037.ts --apply` (with
-- ALLOW_PROD_APPLY=1 set). All three CREATE INDEX statements are
-- idempotent, so reruns are safe.

CREATE INDEX IF NOT EXISTS finding_status_review_id_idx
  ON finding_status (review_id);

CREATE INDEX IF NOT EXISTS finding_status_status_closure_idx
  ON finding_status (status, closure_detected_at);

CREATE INDEX IF NOT EXISTS reviews_public_receipt_idx
  ON reviews (public_receipt);
