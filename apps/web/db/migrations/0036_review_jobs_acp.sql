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
  ADD COLUMN IF NOT EXISTS acp_request_payload jsonb,
  ADD COLUMN IF NOT EXISTS acp_review_id text,
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
    OR acp_submit_status IN ('pending','submitted','submit_failed')
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_jobs_acp_job_id_unique
  ON review_jobs (acp_job_id)
  WHERE payment_rail = 'acp' AND acp_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_review_jobs_acp_review_id
  ON review_jobs (acp_review_id)
  WHERE payment_rail = 'acp' AND acp_review_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_review_jobs_acp_submit_status
  ON review_jobs (acp_submit_status)
  WHERE payment_rail = 'acp';
