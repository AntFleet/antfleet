ALTER TABLE "reviews" ADD COLUMN "processing_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "processing_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "processing_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "processing_finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "next_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "processing_error" text;--> statement-breakpoint
-- Backfill: every pre-existing reviews row is treated as terminal so the
-- new retry cron never picks it up. Without this, the column default of
-- 'pending' would cause the first cron tick after deploy to re-run
-- reviewPR against historical rows (including the stalled aeon-bench
-- burst from 2026-05-18, which the operator decided NOT to retrigger
-- via this code path). The queue applies only to webhook deliveries
-- arriving after this migration runs. processing_finished_at mirrors
-- created_at so the lifecycle timestamps stay coherent for any future
-- audit query.
UPDATE "reviews" SET "processing_status" = 'done', "processing_finished_at" = "created_at";--> statement-breakpoint
CREATE INDEX "reviews_processing_lookup_idx" ON "reviews" USING btree ("processing_status","next_retry_at");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_idempotency_uniq" UNIQUE("repo_hash","pr_number","commit_sha");