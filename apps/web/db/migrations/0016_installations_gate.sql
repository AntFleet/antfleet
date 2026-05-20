CREATE TABLE "installations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "installation_id" bigint NOT NULL,
  "owner" text NOT NULL,
  "repo" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending_approval',
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "approved_at" timestamp with time zone,
  "rejected_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "installations_install_repo_uniq" ON "installations" ("installation_id","repo");
--> statement-breakpoint
CREATE INDEX "installations_status_idx" ON "installations" ("status");
