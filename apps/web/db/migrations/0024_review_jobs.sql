-- API async-default — job persistence for /api/v1/installations/{id}/review
-- Jobs flow: queued → running → (complete | failed | expired)
-- Result is the same ReviewBundle shape returned by the prior sync endpoint.
-- Generic naming (not aeon-specific) — this is the canonical job queue for
-- any v1 review caller.

CREATE TABLE review_jobs (
  job_id text PRIMARY KEY,
  installation_id text NOT NULL,
  wallet_address text NOT NULL,
  repo_owner text NOT NULL,
  repo_name text NOT NULL,
  pr_number integer,
  sha text,
  idempotency_key text,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'failed', 'expired')),
  failure_mode text,
  failure_message text,
  result jsonb,
  debit_payment_id uuid REFERENCES payments(id),
  refund_payment_id uuid REFERENCES payments(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + INTERVAL '24 hours')
);

-- Partial index for stale-job sweep (safety-net cron)
CREATE INDEX review_jobs_status_started_idx ON review_jobs (status, started_at)
  WHERE status IN ('queued', 'running');

-- Installation job history
CREATE INDEX review_jobs_installation_idx ON review_jobs (installation_id, created_at DESC);

-- Idempotent retry: partial unique on (installation_id, idempotency_key) where key is set
CREATE UNIQUE INDEX review_jobs_idempotency_idx ON review_jobs (installation_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- One job per debit, no double-billing
CREATE UNIQUE INDEX review_jobs_debit_payment_idx ON review_jobs (debit_payment_id)
  WHERE debit_payment_id IS NOT NULL;
