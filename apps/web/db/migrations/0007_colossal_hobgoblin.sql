CREATE TABLE "outgoing_prs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_finding_id" text NOT NULL,
	"upstream_owner" text NOT NULL,
	"upstream_repo" text NOT NULL,
	"upstream_pr_number" integer NOT NULL,
	"branch_on_fork" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"merged_at" timestamp with time zone,
	"merge_sha" text,
	"last_polled_at" timestamp with time zone,
	CONSTRAINT "outgoing_prs_upstream_uniq" UNIQUE("upstream_owner","upstream_repo","upstream_pr_number")
);
