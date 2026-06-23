-- Migration 0041: review_gate_outcomes side table.
--
-- Two new review-pipeline stages (reachability gate and patch verifier) emit
-- structured records per finding/patch. We don't want to widen finding_status
-- — `finding-status-patch-side-table-deferral-gate` flags that we should
-- defer per-finding column additions until eval-harness step 3, and the
-- gate-outcomes data is structurally orthogonal anyway (one finding can
-- have one reachability row + N patch_verify rows over its lifetime).
--
-- Schema:
--   review_id    — the reviews row this outcome belongs to.
--   finding_id   — the finding_status.finding_id when the row was emitted
--                  per-finding (patch_verify always; reachability optional
--                  per call site). NULL is permitted so review-wide outcomes
--                  can still slot in.
--   stage        — 'reachability' | 'patch_verify' (free-text by design so
--                  future stages don't need a migration).
--   verdict      — stage-specific enum text. Reachability:
--                  reachable | unreachable | uncertain. Patch verify:
--                  verified | regressed | inconclusive.
--   evidence     — full structured record (the gate output object). JSONB
--                  so we can query verdict-disagreement patterns without
--                  re-running the stage.
--   model_id     — convenience pluck for fast aggregate joins; the same id
--                  also lives inside evidence.
--   created_at   — wall clock for ordering and TTL queries.
--
-- Side-table not column-additions: no schema change to finding_status; no
-- write contention on the existing UPDATE WHERE finding_id = X path used
-- by recordPatchDecisions. New writes are pure INSERTs.

CREATE TABLE IF NOT EXISTS "review_gate_outcomes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "review_id" uuid NOT NULL REFERENCES "reviews" ("review_id") ON DELETE CASCADE,
  "finding_id" text,
  "stage" text NOT NULL,
  "verdict" text NOT NULL,
  "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "model_id" text,
  -- Review attempt this row was emitted from. The kernel retry path
  -- re-runs the entire pipeline on each attempt, so the same finding may
  -- accumulate multiple gate-outcome rows over a review's lifetime. The
  -- attempt column makes those duplicates interpretable as "attempt 1
  -- said reachable; attempt 2 said unreachable" rather than mystery dupes.
  "review_attempt" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "review_gate_outcomes_review_idx"
  ON "review_gate_outcomes" USING btree ("review_id");

CREATE INDEX IF NOT EXISTS "review_gate_outcomes_stage_verdict_idx"
  ON "review_gate_outcomes" USING btree ("stage", "verdict");

CREATE INDEX IF NOT EXISTS "review_gate_outcomes_review_finding_idx"
  ON "review_gate_outcomes" USING btree ("review_id", "finding_id");
