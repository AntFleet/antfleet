-- Migration 0043: repo_threat_model side table.
--
-- Daybreak primitive #3: persist one threat model per repo so review stages
-- can read accumulated repo knowledge instead of re-deriving attack surface
-- on every PR. This is intentionally repo-scoped, not install-scoped:
-- multiple installations of the same repo share the same model.
--
-- Side-table only. No changes to finding_status, reviews, or the
-- review_gate_outcomes stage-evidence table.

CREATE TABLE IF NOT EXISTS "repo_threat_model" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "repo_hash" text NOT NULL UNIQUE,
  "owner" text NOT NULL,
  "repo" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "model" jsonb NOT NULL,
  "public_model" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "provenance" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "generator_model_id" text,
  "last_reviewed_sha" text NOT NULL,
  "entry_points_refreshed_sha" text,
  "trust_boundaries_refreshed_sha" text,
  "sinks_refreshed_sha" text,
  "secrets_surface_refreshed_sha" text,
  "critical_assets_refreshed_sha" text,
  "refresh_count" integer NOT NULL DEFAULT 1,
  -- private | public | live_protocol_review_required
  "public_access" text NOT NULL DEFAULT 'private',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "repo_threat_model_owner_repo_idx"
  ON "repo_threat_model" USING btree (lower("owner"), lower("repo"));

CREATE INDEX IF NOT EXISTS "repo_threat_model_public_access_idx"
  ON "repo_threat_model" USING btree ("public_access");
