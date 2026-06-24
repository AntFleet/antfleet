-- Migration 0045: SARIF ingest/export side tables.
--
-- Adds upload/import state without changing finding_status. One batch row
-- tracks a customer SARIF upload or Code Scanning pull; one finding row tracks
-- each scanner claim and links to finding_status only after AntFleet promotes
-- the claim into its normal finding lifecycle.

CREATE TABLE IF NOT EXISTS "sarif_import_batch" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "installation_id" bigint,
  "owner" text NOT NULL,
  "repo" text NOT NULL,
  "repo_hash" text NOT NULL,
  "source_tool" text NOT NULL,
  "source_kind" text NOT NULL,
  "source_revision" text,
  "source_url" text,
  "file_blob_ref" text,
  "status" text NOT NULL DEFAULT 'pending',
  "total_claims" integer NOT NULL DEFAULT 0,
  "real_count" integer NOT NULL DEFAULT 0,
  "false_positive_count" integer NOT NULL DEFAULT 0,
  "inconclusive_count" integer NOT NULL DEFAULT 0,
  "error_count" integer NOT NULL DEFAULT 0,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "sarif_finding" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "batch_id" uuid NOT NULL REFERENCES "sarif_import_batch"("id") ON DELETE cascade,
  "external_fingerprint" text NOT NULL,
  "source_tool" text NOT NULL,
  "rule_id" text NOT NULL,
  "rule_name" text,
  "level" text NOT NULL DEFAULT 'warning',
  "severity" text NOT NULL DEFAULT 'medium',
  "message" text NOT NULL,
  "artifact_uri" text NOT NULL,
  "start_line" integer,
  "end_line" integer,
  "original_claim" jsonb NOT NULL,
  "normalized_claim" jsonb NOT NULL,
  "validation_verdict" text NOT NULL DEFAULT 'pending',
  "confirmation_verdict" text,
  "reachability_verdict" text,
  "patch_verify_verdict" text,
  "closure_receipt" jsonb,
  "linked_finding_status_id" uuid REFERENCES "finding_status"("id") ON DELETE SET NULL,
  "processed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "sarif_import_batch_repo_idx"
  ON "sarif_import_batch" ("repo_hash", "created_at");

CREATE INDEX IF NOT EXISTS "sarif_import_batch_status_idx"
  ON "sarif_import_batch" ("status", "created_at");

CREATE INDEX IF NOT EXISTS "sarif_finding_batch_idx"
  ON "sarif_finding" ("batch_id");

CREATE INDEX IF NOT EXISTS "sarif_finding_validation_idx"
  ON "sarif_finding" ("validation_verdict", "processed_at");

CREATE UNIQUE INDEX IF NOT EXISTS "sarif_finding_batch_fingerprint_uniq"
  ON "sarif_finding" ("batch_id", "external_fingerprint");
