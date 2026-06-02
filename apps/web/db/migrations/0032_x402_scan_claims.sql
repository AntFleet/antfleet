-- Migration 0032: x402 scan authorization claims and usage accounting

CREATE TABLE IF NOT EXISTS x402_scan_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authorization_key text NOT NULL,
  caller_wallet text NOT NULL,
  repo_owner text NOT NULL,
  repo_name text NOT NULL,
  head_sha text,
  status text NOT NULL DEFAULT 'claimed',
  settlement_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

ALTER TABLE x402_scan_claims
  DROP CONSTRAINT IF EXISTS x402_scan_claims_status_check;

ALTER TABLE x402_scan_claims
  ADD CONSTRAINT x402_scan_claims_status_check
  CHECK (
    status IN (
      'claimed',
      'rate_limited',
      'scan_failed',
      'no_reviewable_files',
      'settlement_failed',
      'settled'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS x402_scan_claims_authorization_key_uniq
  ON x402_scan_claims (authorization_key);

CREATE INDEX IF NOT EXISTS x402_scan_claims_wallet_created_idx
  ON x402_scan_claims (caller_wallet, created_at DESC);

CREATE INDEX IF NOT EXISTS x402_scan_claims_repo_created_idx
  ON x402_scan_claims (repo_owner, repo_name, created_at DESC);

CREATE INDEX IF NOT EXISTS x402_scan_claims_status_idx
  ON x402_scan_claims (status);
