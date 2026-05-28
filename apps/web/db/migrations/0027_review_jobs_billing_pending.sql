-- Allow POST /api/v1/installations/{id}/review to create a non-runnable
-- job before debit succeeds. The worker and safety-net cron only process
-- status='queued', so this closes the unpaid-orphan race.
ALTER TABLE review_jobs
  DROP CONSTRAINT IF EXISTS review_jobs_status_check;

ALTER TABLE review_jobs
  ADD CONSTRAINT review_jobs_status_check
  CHECK (status IN ('billing_pending', 'queued', 'running', 'complete', 'failed', 'expired'));
