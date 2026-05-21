-- Wallet-bound x402 paywall MVP — schema for agent self-onboarding.
--
-- Pre-paywall, the install row was created by the GitHub App webhook the
-- first time a partner-owned repo emitted a `pull_request` event; the gate
-- column (`status`) flipped manually from pending_approval to approved.
-- The new agent flow inverts that order: an agent POSTs its wallet to
-- /v1/installations, signs a binding challenge, prefunds a channel in USDC
-- on Base, and only then installs the GitHub App. The row therefore exists
-- before any `installation_id` / `owner` / `repo` is known, so those three
-- columns must be nullable. Existing rows keep their values and the unique
-- (installation_id, repo) index continues to deduplicate webhook-created
-- rows because Postgres treats each NULL as distinct.

ALTER TABLE "installations" ALTER COLUMN "installation_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "installations" ALTER COLUMN "owner" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "installations" ALTER COLUMN "repo" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "installations"
  ADD COLUMN "wallet_address" text,
  ADD COLUMN "wallet_proof_signature" text,
  ADD COLUMN "wallet_bound_at" timestamp with time zone,
  ADD COLUMN "legacy_partner" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX "installations_wallet_address_idx" ON "installations" ("wallet_address");
--> statement-breakpoint
-- legacyPartner=true grandfathers every install that was already approved
-- under the old human-gated flow, so existing partner repos keep getting
-- reviews without paying. Rows still in pending_approval / rejected remain
-- legacy_partner=false: they have not earned the free pass.
UPDATE "installations" SET "legacy_partner" = true WHERE "status" = 'approved';
--> statement-breakpoint

-- One channel per installation. Balance is the source of truth for the
-- per-review drawdown gate. last_deposit_tx_hash / last_drawdown_at are
-- audit-only conveniences; the full ledger lives in `payments`.
CREATE TABLE "channels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "installation_id" uuid NOT NULL REFERENCES "installations"("id") ON DELETE CASCADE,
  "wallet_address" text NOT NULL,
  "balance_usdc" numeric(18,6) NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_deposit_tx_hash" text,
  "last_drawdown_at" timestamp with time zone
);
--> statement-breakpoint
-- 1:1 with installations. Webhook-created legacy rows have no channel
-- (legacy_partner=true bypasses the balance check).
CREATE UNIQUE INDEX "channels_installation_id_uniq" ON "channels" ("installation_id");
--> statement-breakpoint
-- Wallet → channels lookup for /wallets/[address] reputation page, which
-- aggregates across every installation bound to that wallet.
CREATE INDEX "channels_wallet_address_idx" ON "channels" ("wallet_address");
--> statement-breakpoint

-- Ledger. One row per on-chain deposit detected (synchronously via
-- /deposit or asynchronously via the scan-deposits cron) and one row per
-- per-review drawdown. type is a text-with-CHECK rather than a pg enum so
-- a future row variant (e.g. 'refund') is application-only.
CREATE TABLE "payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "tx_hash" text,
  "chain_id" integer NOT NULL DEFAULT 8453,
  "from_address" text NOT NULL,
  "amount_usdc" numeric(18,6) NOT NULL,
  "block_number" bigint,
  "review_id" uuid REFERENCES "reviews"("review_id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "payments_type_check" CHECK ("type" IN ('deposit', 'drawdown'))
);
--> statement-breakpoint
-- Idempotency for deposit detection. The /deposit endpoint and the
-- scan-deposits cron may both observe the same on-chain Transfer; both
-- INSERT ... ON CONFLICT DO NOTHING against this index. Drawdowns are
-- write-once per review (no on-chain tx) so tx_hash is NULL and the
-- partial predicate skips them.
CREATE UNIQUE INDEX "payments_tx_hash_uniq" ON "payments" ("chain_id", "tx_hash") WHERE "tx_hash" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "payments_channel_id_idx" ON "payments" ("channel_id");
--> statement-breakpoint
-- Drawdown receipt lookup for finding-comment footers ("Settled · tx ...").
CREATE INDEX "payments_review_id_idx" ON "payments" ("review_id") WHERE "review_id" IS NOT NULL;
