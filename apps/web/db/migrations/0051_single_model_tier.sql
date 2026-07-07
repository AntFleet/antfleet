-- Migration 0051 — single-model shadow tier (Win 2).
--
-- Two additive changes, both inert until the ANTFLEET_SINGLE_MODEL_TIER flags
-- flip:
--
-- 1. finding_status.source — tags every lifecycle row with the tier that
--    produced it. 'consensus' (the unanimous-gate findings, index-coupled to
--    agreement_decision.agreed[]) or 'single_model' (the shadow tier, indexed
--    into agreement_decision.singleModelTier[]). NOT NULL DEFAULT 'consensus'
--    so every existing row backfills to the correct value with no data pass —
--    all rows written before this migration are consensus rows. This column
--    is the load-bearing separator: every reader that resolves a row's
--    finding_index against agreed[] filters on source='consensus', and the
--    precision metric segments dismiss-rate by source.
--
-- 2. installations.single_model_tier_enabled — per-install override for the
--    ANTFLEET_SINGLE_MODEL_TIER env flag. Same two-layer pattern as
--    precision_feedback_enabled (0050) / patch_agent_enabled (0019):
--      NULL   → inherit the env default (OFF).
--      true   → force-on for this install regardless of env.
--      false  → force-off for this install regardless of env.
--    Nullable so existing rows need no backfill — NULL is the correct
--    "inherit env" semantics.
--
-- 3. finding_status_review_index_uniq — widened to include source. The old
--    (review_id, finding_index) unique key would collide the first shadow row
--    (source='single_model', finding_index=0) with the first consensus row
--    (source='consensus', finding_index=0) of the same review. Adding source
--    to the key keeps "one consensus row per (review_id, finding_index)" AND
--    "one shadow row per (review_id, finding_index)" without collision. The
--    runtime upsert targets finding_id (distinct `-s` namespace for shadow
--    rows) so this index is hardening only, but it must not reject a valid
--    parallel shadow row. IF EXISTS guards the drop because the 0038 index is
--    documented as optional-hardening and may not be present in every DB.

ALTER TABLE finding_status ADD COLUMN source text NOT NULL DEFAULT 'consensus';

ALTER TABLE installations ADD COLUMN single_model_tier_enabled boolean;

DROP INDEX IF EXISTS finding_status_review_index_uniq;

CREATE UNIQUE INDEX finding_status_review_index_uniq
  ON finding_status (review_id, finding_index, source);
