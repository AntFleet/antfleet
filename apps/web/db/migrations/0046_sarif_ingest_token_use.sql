-- Migration 0046: one-shot SARIF ingest token replay guard.

CREATE TABLE IF NOT EXISTS "sarif_ingest_token_use" (
  "jti" text PRIMARY KEY,
  "installation_id" bigint NOT NULL,
  "repo" text NOT NULL,
  "used_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "sarif_ingest_token_use_used_at_idx"
  ON "sarif_ingest_token_use" ("used_at");
