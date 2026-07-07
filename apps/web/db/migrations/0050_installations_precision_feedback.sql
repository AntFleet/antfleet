-- Migration 0050 — per-install precision_feedback_enabled flag (Step 0.5, item 3).
--
-- Adds a nullable boolean override column to `installations` that lets
-- operators canary the precision-feedback feature on a single install
-- (e.g. aeon-bench) before flipping ANTFLEET_PRECISION_FEEDBACK env-wide.
--
-- Same two-layer pattern as patchAgentEnabled (migration 0019):
--   NULL   → inherit the ANTFLEET_PRECISION_FEEDBACK env default (OFF).
--   true   → force-on for this install regardless of env.
--   false  → force-off for this install regardless of env.
--
-- Column is nullable so existing rows require no backfill — NULL is the
-- correct "inherit env" semantics. Additive only; nothing reads it yet.

ALTER TABLE installations ADD COLUMN precision_feedback_enabled boolean;
