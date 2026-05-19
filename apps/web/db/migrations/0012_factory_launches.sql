CREATE TABLE IF NOT EXISTS "factory_launches" (
	"token_address" text PRIMARY KEY NOT NULL,
	"deployer_address" text NOT NULL,
	"token_name" text,
	"token_symbol" text,
	"block_number" bigint NOT NULL,
	"tx_hash" text NOT NULL,
	"deployed_at" timestamp with time zone NOT NULL,
	"repo_full_name" text,
	"repo_discovered_at" timestamp with time zone,
	"repo_discovery_method" text,
	"prelaunch_status" text DEFAULT 'pending' NOT NULL,
	"prelaunch_finding_id" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cron_cursors" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "roast_submissions" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'public' NOT NULL;
