CREATE TABLE "finding_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"finding_index" integer NOT NULL,
	"finding_id" text NOT NULL,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"category" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closure_sha" text,
	"closure_comment_id" bigint,
	"closure_comment_url" text,
	"closure_detected_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finding_status_finding_id_unique" UNIQUE("finding_id")
);
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "pr_comment_id" bigint;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "pr_comment_url" text;--> statement-breakpoint
ALTER TABLE "finding_status" ADD CONSTRAINT "finding_status_review_id_reviews_review_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("review_id") ON DELETE cascade ON UPDATE no action;