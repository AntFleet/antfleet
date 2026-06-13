-- Migration 0039: x402 review authorization claims (per-authorization replay guard)

CREATE TABLE IF NOT EXISTS x402_review_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authorization_key text NOT NULL,
  caller_wallet text NOT NULL,
  repo_owner text NOT NULL,
  repo_name text NOT NULL,
  pr_number integer,
  head_sha text,
  job_id text,
  status text NOT NULL DEFAULT 'claimed',
  settlement_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

ALTER TABLE x402_review_claims
  DROP CONSTRAINT IF EXISTS x402_review_claims_status_check;

ALTER TABLE x402_review_claims
  ADD CONSTRAINT x402_review_claims_status_check
  CHECK (
    status IN (
      'claimed',
      'rate_limited',
      'validation_failed',
      'dispatch_failed',
      'settlement_failed',
      'settled'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS x402_review_claims_authorization_key_uniq
  ON x402_review_claims (authorization_key);

CREATE INDEX IF NOT EXISTS x402_review_claims_wallet_created_idx
  ON x402_review_claims (caller_wallet, created_at DESC);

CREATE INDEX IF NOT EXISTS x402_review_claims_repo_created_idx
  ON x402_review_claims (repo_owner, repo_name, created_at DESC);

CREATE INDEX IF NOT EXISTS x402_review_claims_status_idx
  ON x402_review_claims (status);
