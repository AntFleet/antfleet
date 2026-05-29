-- Migration 0028: x402-rail support for review_jobs
--
-- Adds the columns x402 jobs need (caller wallet, rail metadata, deferred
-- payment authorization, review linkage, and settlement status) plus indexes
-- for lookup/listing. Does NOT add a CHECK
-- constraint on failure_mode; the production channel rail writes additional
-- literals (e.g. 'insufficient_channel_balance') that are gated at the
-- application layer via apps/web/lib/paywall/refund.ts.

ALTER TABLE review_jobs
  DROP CONSTRAINT IF EXISTS review_jobs_payment_rail_check;

ALTER TABLE review_jobs
  ADD COLUMN IF NOT EXISTS caller_wallet text,
  ADD COLUMN IF NOT EXISTS payment_rail text NOT NULL DEFAULT 'channel',
  ADD COLUMN IF NOT EXISTS x402_pay_to text,
  ADD COLUMN IF NOT EXISTS x402_payment_payload jsonb,
  ADD COLUMN IF NOT EXISTS x402_valid_after timestamptz,
  ADD COLUMN IF NOT EXISTS x402_valid_before timestamptz,
  ADD COLUMN IF NOT EXISTS x402_review_id text,
  ADD COLUMN IF NOT EXISTS x402_settlement_status text,
  ADD COLUMN IF NOT EXISTS x402_settlement_response jsonb;

UPDATE review_jobs SET payment_rail = 'channel' WHERE payment_rail IS NULL;

ALTER TABLE review_jobs
  ADD CONSTRAINT review_jobs_payment_rail_check
  CHECK (payment_rail IN ('channel','x402'));

ALTER TABLE review_jobs
  DROP CONSTRAINT IF EXISTS review_jobs_x402_settlement_status_check;

ALTER TABLE review_jobs
  ADD CONSTRAINT review_jobs_x402_settlement_status_check
  CHECK (
    x402_settlement_status IS NULL
    OR x402_settlement_status IN ('pending','settled','not_settled','settlement_failed')
  );

CREATE INDEX IF NOT EXISTS idx_review_jobs_caller_wallet
  ON review_jobs (caller_wallet)
  WHERE caller_wallet IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_review_jobs_payment_rail_created
  ON review_jobs (payment_rail, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_jobs_rail_installation_idempotency_unique
  ON review_jobs (payment_rail, installation_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_review_jobs_x402_pay_to
  ON review_jobs (x402_pay_to)
  WHERE x402_pay_to IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_review_jobs_x402_review_id
  ON review_jobs (x402_review_id)
  WHERE x402_review_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_review_jobs_x402_settlement_status
  ON review_jobs (x402_settlement_status)
  WHERE payment_rail = 'x402';
