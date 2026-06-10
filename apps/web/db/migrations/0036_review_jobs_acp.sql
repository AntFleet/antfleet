-- Migration 0036: Virtuals ACP rail support for review_jobs.
--
-- ACP jobs use the existing AntFleet review_jobs worker. ACP-specific columns
-- persist the marketplace job id, the original validated request, the linked
-- AntFleet review id, and the provider-submit status.

ALTER TABLE review_jobs
  DROP CONSTRAINT IF EXISTS review_jobs_payment_rail_check;

ALTER TABLE review_jobs
  ADD COLUMN IF NOT EXISTS acp_job_id text,
  ADD COLUMN IF NOT EXISTS acp_client_wallet text,
  ADD COLUMN IF NOT EXISTS acp_target_key text,
  ADD COLUMN IF NOT EXISTS acp_request_payload jsonb,
  ADD COLUMN IF NOT EXISTS acp_review_id text,
  ADD COLUMN IF NOT EXISTS acp_budget_status text,
  ADD COLUMN IF NOT EXISTS acp_budget_response jsonb,
  ADD COLUMN IF NOT EXISTS acp_budget_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS acp_budget_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS acp_submit_status text,
  ADD COLUMN IF NOT EXISTS acp_submit_response jsonb,
  ADD COLUMN IF NOT EXISTS acp_submitted_at timestamptz;

ALTER TABLE review_jobs
  ADD CONSTRAINT review_jobs_payment_rail_check
  CHECK (payment_rail IN ('channel','x402','acp'));

ALTER TABLE review_jobs
  DROP CONSTRAINT IF EXISTS review_jobs_acp_submit_status_check;

ALTER TABLE review_jobs
  ADD CONSTRAINT review_jobs_acp_submit_status_check
  CHECK (
    acp_submit_status IS NULL
    OR acp_submit_status IN ('pending','submitting','submitted','submit_failed')
  );

ALTER TABLE review_jobs
  DROP CONSTRAINT IF EXISTS review_jobs_acp_budget_status_check;

ALTER TABLE review_jobs
  ADD CONSTRAINT review_jobs_acp_budget_status_check
  CHECK (
    acp_budget_status IS NULL
    OR acp_budget_status IN ('pending','setting','set','set_failed','set_reconcile')
  );

ALTER TABLE review_jobs
  DROP CONSTRAINT IF EXISTS review_jobs_acp_wallet_check;

ALTER TABLE review_jobs
  ADD CONSTRAINT review_jobs_acp_wallet_check
  CHECK (
    payment_rail <> 'acp'
    OR (
      acp_client_wallet IS NOT NULL
      AND caller_wallet IS NOT NULL
      AND wallet_address = acp_client_wallet
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_jobs_acp_job_id_unique
  ON review_jobs (acp_job_id)
  WHERE payment_rail = 'acp' AND acp_job_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_jobs_acp_target_key_unique
  ON review_jobs (acp_target_key)
  WHERE payment_rail = 'acp' AND acp_target_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_review_jobs_acp_review_id
  ON review_jobs (acp_review_id)
  WHERE payment_rail = 'acp' AND acp_review_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_review_jobs_acp_budget_status
  ON review_jobs (acp_budget_status)
  WHERE payment_rail = 'acp';

CREATE INDEX IF NOT EXISTS idx_review_jobs_acp_submit_status
  ON review_jobs (acp_submit_status)
  WHERE payment_rail = 'acp';

CREATE TABLE IF NOT EXISTS acp_provider_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL,
  acp_job_id text,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  next_retry_at timestamptz
);

ALTER TABLE acp_provider_events
  DROP CONSTRAINT IF EXISTS acp_provider_events_status_check;

ALTER TABLE acp_provider_events
  ADD CONSTRAINT acp_provider_events_status_check
  CHECK (status IN ('pending','processing','processed','failed','dead_lettered'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_acp_provider_events_event_key_unique
  ON acp_provider_events (event_key);

CREATE INDEX IF NOT EXISTS idx_acp_provider_events_status_next_retry
  ON acp_provider_events (status, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_acp_provider_events_acp_job
  ON acp_provider_events (acp_job_id);
