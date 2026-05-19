CREATE TABLE IF NOT EXISTS "agent_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"token_address" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimer_signature" text NOT NULL,
	"claimer_address" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"rejection_reason" text,
	"verified_at" timestamp with time zone
);
