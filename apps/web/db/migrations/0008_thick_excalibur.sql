ALTER TABLE "reviews" ADD COLUMN "processing_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "processing_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "processing_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "processing_finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "next_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "processing_error" text;--> statement-breakpoint
CREATE INDEX "reviews_processing_lookup_idx" ON "reviews" USING btree ("processing_status","next_retry_at");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_idempotency_uniq" UNIQUE("repo_hash","pr_number","commit_sha");