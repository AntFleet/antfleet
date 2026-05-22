-- Patch Agent v1.6 — click-to-apply lane. Additive schema for the new
-- PR review-comment poster + sweep-side apply detection. Every column
-- is NULLABLE so the flag-off path (PATCH_AGENT_CLICK_APPLY_ENABLED=false)
-- preserves byte-identical behavior with v1.5. Forward-only: rows that
-- predate this migration stay NULL on every new column.
--
-- Distinction from v1.5's patch_accepted_at:
--   patch_accepted_at      = sweeper found the patch contents in HEAD
--                            (could be click-apply OR a manual commit)
--   patch_apply_clicked_at = sweeper specifically observed the GitHub
--                            "Commit suggestion" button being used
--                            (a refinement; click-apply rows will also
--                            have patch_accepted_at set)
--
-- No change to reviews, channels, payments, or the agreement_decision
-- JSONB shape. Drawdown still charges REVIEW_PRICE_USDC once per review.

-- finding_status: track the review-comment artifact we posted (for
-- idempotency on review-worker retry) and the apply-click acceptance
-- transition (for sweep-side detection + the patch_apply_clicked event).
-- patchReviewCommentId is GitHub's bigint comment id; patchReviewCommentUrl
-- is the html_url returned by pulls.createReviewComment. patchReviewProposedAt
-- stamps when we successfully posted the review comment.
ALTER TABLE "finding_status"
  ADD COLUMN "patch_review_comment_id" bigint,
  ADD COLUMN "patch_review_comment_url" text,
  ADD COLUMN "patch_review_proposed_at" timestamp with time zone,
  ADD COLUMN "patch_apply_clicked_at" timestamp with time zone;
--> statement-breakpoint

-- Sweeper apply-detection pass scans finding_status rows where a review
-- comment was posted but apply-click has not yet been observed. Partial
-- index keeps the scan tight without touching the v1.5 patch-acceptance
-- hot path (finding_status_pending_patch_idx).
CREATE INDEX "finding_status_pending_review_comment_apply_idx"
  ON "finding_status" ("patch_review_comment_id")
  WHERE "patch_review_comment_id" IS NOT NULL
    AND "patch_apply_clicked_at" IS NULL;
--> statement-breakpoint

-- Per-install override for the PATCH_AGENT_CLICK_APPLY_ENABLED env flag.
-- NULL = inherit env default (false in prod, true in dev). Non-null =
-- force on/off for this install regardless of env. Mirrors the v1.5
-- patch_agent_enabled column pattern; used to canary one install
-- (AntFleet/aeon-bench) before flipping the env-wide default.
ALTER TABLE "installations"
  ADD COLUMN "patch_agent_click_apply_enabled" boolean;
