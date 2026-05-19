ALTER TABLE "agent_findings" ADD COLUMN IF NOT EXISTS "repo_full_name" text;

UPDATE "agent_findings"
SET "repo_full_name" = 'Liquid-Protocol-Ops/agent-autonomopoly'
WHERE lower("agent_token_address") = lower('0xB3D7e0c3C39A1D3F1B304663065A2F83Ddf56d8e')
  AND "repo_full_name" IS NULL;

CREATE TABLE IF NOT EXISTS "drift_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_token_address" text NOT NULL,
	"commit_sha" text NOT NULL,
	"commit_timestamp" timestamp with time zone NOT NULL,
	"drift_score" numeric NOT NULL,
	"threshold" numeric NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
