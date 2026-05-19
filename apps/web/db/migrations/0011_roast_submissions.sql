CREATE TABLE IF NOT EXISTS "roast_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_url" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"submitter_email" text,
	"submitter_handle" text,
	"ip_hash" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"receipt_id" text,
	"rejection_reason" text
);
