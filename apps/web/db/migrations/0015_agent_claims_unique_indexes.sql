CREATE UNIQUE INDEX IF NOT EXISTS "agent_claims_token_verified_unique"
  ON "agent_claims" (lower("token_address"))
  WHERE status = 'verified';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_claims_signature_unique"
  ON "agent_claims" ("claimer_signature");
