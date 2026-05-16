CREATE TABLE "maintainer_reactions" (
	"reaction_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"finding_id" text NOT NULL,
	"action_taken" text NOT NULL,
	"reaction_at" timestamp with time zone NOT NULL,
	"maintainer_comment" text,
	"polled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"review_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_hash" text NOT NULL,
	"pr_number" integer NOT NULL,
	"commit_sha" text NOT NULL,
	"files_reviewed" text[] NOT NULL,
	"prompt_version" text NOT NULL,
	"provider_model_ids" jsonb NOT NULL,
	"provider_responses" jsonb NOT NULL,
	"agreement_decision" jsonb NOT NULL,
	"timing_ms" integer NOT NULL,
	"cost_estimated_usd" numeric(10, 4) NOT NULL,
	"schema_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "maintainer_reactions" ADD CONSTRAINT "maintainer_reactions_review_id_reviews_review_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("review_id") ON DELETE cascade ON UPDATE no action;