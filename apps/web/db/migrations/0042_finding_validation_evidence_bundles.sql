-- Migration 0042: finding validation evidence bundles.
--
-- Public receipts need a compact "why this is real" proof bundle per
-- finding: reviewer PoC snippet, patch-verifier reproduction command, and
-- reachability call path. This data is structurally separate from
-- finding_status lifecycle fields, so it lives in a side table rather than
-- widening finding_status.
--
-- Rows are upserted by the review worker when ANTFLEET_EVIDENCE_BUNDLE is
-- enabled. The three evidence slots are nullable; bundle_status is derived
-- by the writer as complete | partial | empty.

CREATE TABLE IF NOT EXISTS "finding_validation_evidence_bundles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "review_id" uuid NOT NULL REFERENCES "reviews" ("review_id") ON DELETE CASCADE,
  "finding_id" text NOT NULL,
  "review_attempt" integer NOT NULL DEFAULT 1,
  "affected_sha" text NOT NULL,
  "poc_snippet" jsonb,
  "reproduction_command" jsonb,
  "call_path_trace" jsonb,
  "bundle_status" text NOT NULL DEFAULT 'empty',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "finding_validation_evidence_bundle_status_check"
    CHECK ("bundle_status" IN ('complete', 'partial', 'empty')),
  CONSTRAINT "finding_validation_evidence_bundle_uniq"
    UNIQUE ("review_id", "finding_id", "review_attempt")
);

CREATE INDEX IF NOT EXISTS "finding_validation_evidence_bundle_finding_idx"
  ON "finding_validation_evidence_bundles" USING btree ("finding_id");

CREATE INDEX IF NOT EXISTS "finding_validation_evidence_bundle_status_idx"
  ON "finding_validation_evidence_bundles" USING btree ("bundle_status");
