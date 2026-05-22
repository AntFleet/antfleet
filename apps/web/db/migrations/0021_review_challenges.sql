-- Review-challenge nonces for the on-demand review endpoint
-- (POST /api/v1/installations/{id}/review).
--
-- The /bind endpoint uses a stateless challenge derived from
-- installations.created_at (one-shot per install lifetime, no DB row).
-- The review endpoint is repeating — the same wallet may trigger many
-- reviews — so we need fresh single-use nonces with anti-replay.
--
-- Flow:
--   1. POST /api/v1/installations/{id}/review/challenge inserts a row;
--      returns challenge_id + the canonical challenge string.
--   2. Caller signs the challenge string with the bound wallet.
--   3. POST /api/v1/installations/{id}/review verifies the signature,
--      then atomically `UPDATE ... SET used_at = now() WHERE used_at IS NULL`.
--      A 0-row result means another request already redeemed this
--      challenge — return 401 challenge_already_used.
--
-- Idempotency: the challenge_id itself is the single-use token. We do
-- NOT enforce uniqueness on (installation_id, *) — many concurrent
-- challenges per install are fine, only the redemption is single-use.

CREATE TABLE "review_challenges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "installation_row_id" uuid NOT NULL REFERENCES "installations"("id") ON DELETE CASCADE,
  "issued_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "used_for_review_id" uuid REFERENCES "reviews"("review_id") ON DELETE SET NULL
);
--> statement-breakpoint

-- Lookup hot path: server fetches by (id, installation_row_id) to verify
-- the challenge_id is scoped to the URL's {id}. The PK on id is enough
-- for the lookup; the secondary filter on installation_row_id is a
-- correctness guard (a challenge issued for install A can't be redeemed
-- on install B's endpoint).
CREATE INDEX "review_challenges_installation_idx"
  ON "review_challenges" ("installation_row_id");
--> statement-breakpoint

-- Cleanup hot path for future: a cron job (not in this sprint) will
-- delete expired+used rows older than 7 days. The partial index makes
-- that scan cheap without touching the in-flight challenge lookups.
CREATE INDEX "review_challenges_expired_idx"
  ON "review_challenges" ("expires_at")
  WHERE "used_at" IS NULL;
