-- Migration 0038: natural uniqueness key for finding_status.
--
-- The audit/quick-wins round-5 change widened finding_id from
-- <short>-<index> (~32 bits of entropy) to <full-uuid>-<index> to close
-- a collision risk. Round 6 then caught that an existing review's
-- post-deploy retry would compute a finding_id different from the
-- pre-deploy row's, so the upsert's onConflictDoUpdate target
-- (finding_id) no longer matches, producing a duplicate row per
-- (review_id, finding_index).
--
-- Add UNIQUE(review_id, finding_index) so the recordFindingStatuses
-- upsert can target the natural key. Existing rows are already unique
-- on this pair (the old finding_id constraint enforced it transitively
-- through deterministic generation), so the index creation succeeds
-- without prior data cleanup. Operator applies via
-- `pnpm exec tsx db/migrations/apply-migration-0038.ts --apply` with
-- ALLOW_PROD_APPLY=1.

CREATE UNIQUE INDEX IF NOT EXISTS finding_status_review_index_uniq
  ON finding_status (review_id, finding_index);
