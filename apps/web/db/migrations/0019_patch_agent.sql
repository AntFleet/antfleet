-- Patch Agent v1.5 — additive schema for the suggested-patch reviewer lane.
--
-- Every column added here is NULLABLE so the flag-off path (and all rows
-- predating this migration) preserve byte-identical behavior. Comment posting,
-- sweeper closure detection, and the wallet reputation aggregator all gate
-- on the new columns being non-null before changing their output.
--
-- No changes to channels, payments, or the agreement_decision JSONB shape.

-- One row per agreed finding. v1.5 extends with the suggested-patch lifecycle.
-- suggested_patch holds the unified-diff text that was rendered inside the
-- ```suggestion block; capped at 20 lines pre-persist. patch_model_id names
-- the provider whose patch shipped (always Opus in v1 — patch-gate ships
-- the deterministic winner). patch_skip_reason explains why no patch shipped:
-- one of 'models_disagreed' | 'outside_diff_hunk' | 'generation_error' |
-- 'disabled' | 'size_cap'. patch_accepted_at + sha land when the sweeper's
-- patch-acceptance pass detects the suggestion in HEAD on the default branch.
ALTER TABLE "finding_status"
  ADD COLUMN "suggested_patch" text,
  ADD COLUMN "patch_proposed_at" timestamp with time zone,
  ADD COLUMN "patch_model_id" text,
  ADD COLUMN "patch_accepted_at" timestamp with time zone,
  ADD COLUMN "patch_accepted_sha" text,
  ADD COLUMN "patch_skip_reason" text;
--> statement-breakpoint

-- Sweeper patch-acceptance pass scans finding_status rows where a patch was
-- proposed and not yet accepted. Partial index keeps the scan tight without
-- touching the existing closure-detection hot path.
CREATE INDEX "finding_status_pending_patch_idx"
  ON "finding_status" ("patch_proposed_at")
  WHERE "patch_proposed_at" IS NOT NULL AND "patch_accepted_at" IS NULL;
--> statement-breakpoint

-- Patch-generation cost is observability-only. The drawdown gate continues
-- to charge REVIEW_PRICE_USDC regardless of whether a patch was attempted
-- or shipped. Nullable so pre-Patch-Agent rows and flag-off rows are
-- distinguishable from "attempted but zero-cost" rows.
ALTER TABLE "reviews"
  ADD COLUMN "cost_patch_usd" numeric(10, 4);
--> statement-breakpoint

-- Per-install override for the PATCH_AGENT_ENABLED env flag. NULL = inherit
-- env default (false in prod, true in dev). Non-null = force on/off for
-- this install regardless of env. Used to canary one install before
-- flipping the env-wide default. No backfill — every existing install
-- starts as NULL, i.e. governed by the env flag.
ALTER TABLE "installations"
  ADD COLUMN "patch_agent_enabled" boolean;
