-- Migration 0044: coordinated disclosure state machine.
--
-- `reviews.public_receipt` remains as the legacy base visibility policy.
-- Per-finding disclosure state lives beside finding_status so live-mainnet
-- embargoes do not widen the lifecycle row or contend with patch/sweep writes.
--
-- Side-table only for finding state; the only repo-level addition is the
-- operator-managed installations.is_live_protocol flag, default false.

ALTER TABLE "installations"
  ADD COLUMN IF NOT EXISTS "is_live_protocol" boolean DEFAULT false NOT NULL;

CREATE INDEX IF NOT EXISTS "installations_live_protocol_idx"
  ON "installations" USING btree ("is_live_protocol");

CREATE TABLE IF NOT EXISTS "finding_disclosure" (
  "finding_id" text PRIMARY KEY REFERENCES "finding_status" ("finding_id") ON DELETE CASCADE,
  "review_id" uuid NOT NULL REFERENCES "reviews" ("review_id") ON DELETE CASCADE,
  "state" text NOT NULL DEFAULT 'none',
  "entered_at" timestamp with time zone NOT NULL DEFAULT now(),
  "embargo_expires_at" timestamp with time zone,
  "cve_id" text,
  "cve_requested_at" timestamp with time zone,
  "ghsa_id" text,
  "ghsa_html_url" text,
  "ghsa_published_at" timestamp with time zone,
  "ghsa_reservation_token" text,
  "acknowledged_at" timestamp with time zone,
  "acknowledged_by" text,
  "forced_by" text,
  "maintainer_url_ciphertext" text,
  "maintainer_url_log_id" text,
  "advisory_draft" text,
  "advisory_draft_updated_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "finding_disclosure_state_check"
    CHECK ("state" IN (
      'none',
      'embargoed',
      'maintainer-acknowledged',
      'patch-merged',
      'embargo-expired',
      'published'
    ))
);

CREATE INDEX IF NOT EXISTS "finding_disclosure_review_idx"
  ON "finding_disclosure" USING btree ("review_id");

CREATE INDEX IF NOT EXISTS "finding_disclosure_state_idx"
  ON "finding_disclosure" USING btree ("state");

CREATE INDEX IF NOT EXISTS "finding_disclosure_embargo_expires_idx"
  ON "finding_disclosure" USING btree ("embargo_expires_at");

ALTER TABLE "finding_disclosure"
  ADD COLUMN IF NOT EXISTS "ghsa_published_at" timestamp with time zone;

ALTER TABLE "finding_disclosure"
  ADD COLUMN IF NOT EXISTS "ghsa_html_url" text;

ALTER TABLE "finding_disclosure"
  ADD COLUMN IF NOT EXISTS "ghsa_reservation_token" text;

CREATE TABLE IF NOT EXISTS "finding_disclosure_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "finding_id" text NOT NULL REFERENCES "finding_disclosure" ("finding_id") ON DELETE CASCADE,
  "from_state" text,
  "to_state" text NOT NULL,
  "actor_type" text NOT NULL,
  "actor_id" text,
  "reason" text NOT NULL,
  "at_sha" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "finding_disclosure_log_to_state_check"
    CHECK ("to_state" IN (
      'none',
      'embargoed',
      'maintainer-acknowledged',
      'patch-merged',
      'embargo-expired',
      'published'
    )),
  CONSTRAINT "finding_disclosure_log_from_state_check"
    CHECK (
      "from_state" IS NULL OR "from_state" IN (
        'none',
        'embargoed',
        'maintainer-acknowledged',
        'patch-merged',
        'embargo-expired',
        'published'
      )
    ),
  CONSTRAINT "finding_disclosure_log_actor_type_check"
    CHECK ("actor_type" IN ('system', 'maintainer', 'operator'))
);

CREATE INDEX IF NOT EXISTS "finding_disclosure_log_finding_idx"
  ON "finding_disclosure_log" USING btree ("finding_id");

CREATE INDEX IF NOT EXISTS "finding_disclosure_log_created_idx"
  ON "finding_disclosure_log" USING btree ("created_at");
