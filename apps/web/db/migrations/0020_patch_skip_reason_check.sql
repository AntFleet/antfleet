-- Patch Agent v1.5 — audit-response hardening (PR8).
--
-- Migration 0019 added `patch_skip_reason` as free text. The application
-- layer's PatchSkipReason union enforces the five valid values, but the
-- DB has no fence — a future caller bypassing TS could write garbage.
-- This adds the CHECK constraint to match how `payments.type` is gated
-- (see migration 0018). Existing rows are unaffected: every row at
-- migration time has patch_skip_reason NULL (the partial index over
-- patch_proposed_at means no row can have a non-null skip reason yet).

ALTER TABLE "finding_status"
  ADD CONSTRAINT "finding_status_patch_skip_reason_check"
  CHECK (
    "patch_skip_reason" IS NULL
    OR "patch_skip_reason" IN (
      'models_disagreed',
      'outside_diff_hunk',
      'generation_error',
      'disabled',
      'size_cap'
    )
  );
