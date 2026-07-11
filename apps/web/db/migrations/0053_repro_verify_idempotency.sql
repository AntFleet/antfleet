-- Migration 0053 — repro_verify side-table idempotency (issue #145, FIX G).
--
-- The repro-exec record phase (scripts/repro-verify-batch.ts, stage
-- 'repro_verify') previously guarded duplicates with a check-then-insert, which
-- is racy: two concurrent record runs could both see "no row" and both write.
-- This adds a PARTIAL UNIQUE index so the database enforces "at most one
-- repro_verify row per (review_id, finding_id)", and the record phase's insert
-- uses ON CONFLICT DO NOTHING against it (atomic, single round-trip).
--
-- PARTIAL — scoped to WHERE stage = 'repro_verify' so it does NOT constrain the
-- existing 'reachability' / 'patch_verify' stages, which legitimately write
-- multiple rows per (review_id, finding_id) across review attempts. Only the
-- new side-table stage is deduplicated.
--
-- SAFE to add with NO backfill / no conflict risk: 'repro_verify' is a
-- brand-new stage value with ZERO pre-existing rows (the record phase that
-- writes it has never run against any DB), so the unique index cannot collide
-- with existing data. Additive only.

CREATE UNIQUE INDEX review_gate_outcomes_repro_verify_uniq
  ON review_gate_outcomes (review_id, finding_id)
  WHERE stage = 'repro_verify';
