CREATE TABLE "agent_findings" (
	"finding_id" text PRIMARY KEY NOT NULL,
	"agent_token_address" text NOT NULL,
	"agent_name" text NOT NULL,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"summary" text NOT NULL,
	"evidence" text,
	"upstream_pr_url" text,
	"upstream_merged_sha" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
