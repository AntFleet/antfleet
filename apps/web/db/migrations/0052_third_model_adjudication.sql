-- Migration 0052 — 3rd-model adjudication → two_of_three sub-tier (Build B).
--
-- Extends Win2's single-model shadow tier (migration 0051). A single
-- independent 3rd-model (GLM 5.2, Build A adapter) confirm/reject call runs
-- per shadow finding; a `confirm` verdict graduates that finding to the
-- `two_of_three` corroborated sub-tier. Both additive changes are inert until
-- the ANTFLEET_THIRD_MODEL_ADJUDICATION flags flip.
--
-- 1. finding_status.corroborated — the two_of_three graduation marker. Stays
--    within Win2's source='single_model' tier (NEVER widens `source` to a
--    3-value enum — that would force re-auditing every source='consensus'
--    reader-guard). corroborated=true on a source='single_model' row IS the
--    two_of_three sub-tier. NOT NULL DEFAULT false so every existing row
--    backfills correctly with no data pass: all pre-0052 rows are
--    uncorroborated (no adjudication ran). Every public reader-guard already
--    excludes source='single_model' entirely, so corroborated adds NO new
--    public exposure — it is a measurement axis inside the guarded shadow set.
--
-- 2. installations.third_model_adjudication_enabled — per-install override for
--    the ANTFLEET_THIRD_MODEL_ADJUDICATION env flag. Same two-layer pattern as
--    single_model_tier_enabled (0051) / precision_feedback_enabled (0050):
--      NULL   → inherit the env default (OFF).
--      true   → force-on for this install regardless of env.
--      false  → force-off for this install regardless of env.
--    Nullable so existing rows need no backfill — NULL is the correct
--    "inherit env" semantics.

ALTER TABLE finding_status ADD COLUMN corroborated boolean NOT NULL DEFAULT false;

ALTER TABLE installations ADD COLUMN third_model_adjudication_enabled boolean;
