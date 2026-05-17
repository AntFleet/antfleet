CREATE TABLE "onboarding_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"installation_id" bigint NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"repo_hash" text NOT NULL,
	"model_id" text,
	"prompt" text,
	"tool_output" jsonb NOT NULL,
	"comment_id" bigint,
	"comment_url" text,
	"public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
