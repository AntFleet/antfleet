CREATE TABLE IF NOT EXISTS "weekly_features" (
	"week_start" date PRIMARY KEY NOT NULL,
	"finding_id" text NOT NULL,
	"curated_by" text NOT NULL,
	"rationale" text,
	"featured_at" timestamp with time zone DEFAULT now() NOT NULL
);
