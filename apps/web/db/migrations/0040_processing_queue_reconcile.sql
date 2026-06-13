-- Migration 0040: reconcile the processing-queue columns from migration 0008.
--
-- Migration 0008 introduced the review processing-queue columns
-- (processing_status, processing_attempts, processing_started_at,
-- processing_finished_at, next_retry_at, processing_error) plus the
-- reviews_idempotency_uniq constraint and the reviews_processing_lookup_idx
-- index. The production Neon DB drifted from 0008 (it was applied via
-- hand-rolled SQL outside the runner pattern) and never picked up these
-- columns. The retired _apply-missing-cols.ts operator script reconciled
-- prod on 2026-06-13; this migration promotes that one-off into a real,
-- runner-driven migration so any future environment can be brought to the
-- same state via the standard apply-migration flow.
--
-- Safe to re-run: every DDL is IF NOT EXISTS or DROP-then-ADD-IF-EQUAL,
-- and the backfill UPDATE is scoped to rows older than 5 minutes so an
-- in-flight pending review cannot be clobbered.

ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "processing_status" text DEFAULT 'pending' NOT NULL;
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "processing_attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "processing_started_at" timestamp with time zone;
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "processing_finished_at" timestamp with time zone;
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "next_retry_at" timestamp with time zone;
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "processing_error" text;

ALTER TABLE "reviews" DROP CONSTRAINT IF EXISTS "reviews_idempotency_uniq";
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_idempotency_uniq" UNIQUE ("repo_hash", "pr_number", "commit_sha");

CREATE INDEX IF NOT EXISTS "reviews_processing_lookup_idx"
  ON "reviews" USING btree ("processing_status", "next_retry_at");

UPDATE "reviews"
   SET "processing_status" = 'done',
       "processing_finished_at" = COALESCE("processing_finished_at", "created_at")
 WHERE "processing_status" = 'pending'
   AND "created_at" < statement_timestamp() - interval '5 minutes';
