-- Eval Phase 0 — dual-candidate persistence
-- Adds per-provider patch candidates, the shipped patch, and the selector decision
-- so eval-harness step 3 can ETL (category x severity x proposing_model x accepted).
-- Original suggested_patch + patch_model_id columns preserved for backward compat.

ALTER TABLE finding_status
  ADD COLUMN suggested_patch_opus text,
  ADD COLUMN suggested_patch_gpt5 text,
  ADD COLUMN patch_shipped text,
  ADD COLUMN patch_selector text;

-- Backfill: any existing row attributed to Opus migrates to the new shape.
-- WHERE suggested_patch_opus IS NULL guards idempotency.
UPDATE finding_status
SET
  suggested_patch_opus = suggested_patch,
  patch_shipped = suggested_patch,
  patch_selector = 'deterministic-opus'
WHERE suggested_patch IS NOT NULL
  AND patch_model_id = 'claude-opus-4-7'
  AND suggested_patch_opus IS NULL;
