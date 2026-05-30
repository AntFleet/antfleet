// Patch Agent — weekly cost reconciliation (Option B, belt-and-suspenders).
//
// Option A (patch-cost.ts + patch-agent.ts) writes reviews.cost_patch_usd at
// review time from real token counts. This cron backfills rows that predate
// Option A — reviews where cost_patch_usd is still NULL/0 but whose findings
// show a patch actually ran (suggested_patch_opus IS NOT NULL). It prefers the
// per-finding token columns (migration 0029) when present and falls back to a
// documented heuristic when a row was never measured.
//
// Scheduled Monday 02:00 UTC (low-traffic window) ahead of the regression
// fixtures cron. Idempotent: once a review's cost is written non-zero it drops
// out of the candidate set on the next run.

import { and, gte, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/db/index";
import { findingStatus, reviews } from "@/db/schema";
import { callCostUsd } from "./patch-cost";

// Heuristic fallback when a finding's token columns are all NULL (the row
// predates instrumentation). Conservative per-call estimate for a single
// patch-proposal exchange: a compact finding prompt in, a small unified diff
// out. Documented so a reviewer can sanity-check the backfilled numbers.
export const HEURISTIC_OPUS_USAGE = { inputTokens: 2000, outputTokens: 500 };
export const HEURISTIC_GPT5_USAGE = { inputTokens: 2000, outputTokens: 500 };

export type ReconcileFindingRow = {
  inputTokensOpus: number | null;
  outputTokensOpus: number | null;
  inputTokensGpt5: number | null;
  outputTokensGpt5: number | null;
};

/**
 * Cost in USD for one review's patch lane, summed across its patch-ran
 * findings. Pure. For each finding: if either provider has a measured token
 * count, price the measured values (a missing side counts as $0 — that
 * provider made no billable call); if BOTH sides are entirely unmeasured,
 * fall back to the heuristic for both providers.
 */
export function reconcileReviewCostUsd(findings: readonly ReconcileFindingRow[]): number {
  let sum = 0;
  for (const f of findings) {
    const measured =
      f.inputTokensOpus !== null ||
      f.outputTokensOpus !== null ||
      f.inputTokensGpt5 !== null ||
      f.outputTokensGpt5 !== null;
    if (measured) {
      const opus =
        f.inputTokensOpus !== null || f.outputTokensOpus !== null
          ? { inputTokens: f.inputTokensOpus ?? 0, outputTokens: f.outputTokensOpus ?? 0 }
          : null;
      const gpt5 =
        f.inputTokensGpt5 !== null || f.outputTokensGpt5 !== null
          ? { inputTokens: f.inputTokensGpt5 ?? 0, outputTokens: f.outputTokensGpt5 ?? 0 }
          : null;
      sum += callCostUsd("anthropic", "claude-opus-4-7", opus);
      sum += callCostUsd("openai", "gpt-5", gpt5);
    } else {
      sum += callCostUsd("anthropic", "claude-opus-4-7", HEURISTIC_OPUS_USAGE);
      sum += callCostUsd("openai", "gpt-5", HEURISTIC_GPT5_USAGE);
    }
  }
  return Math.round(sum * 10_000) / 10_000;
}

export type ReconcileSummary = {
  reviewsScanned: number;
  reviewsUpdated: number;
  totalEstimatedUsd: number;
  averagePerReviewUsd: number;
};

export type ReconcileDeps = {
  loadCandidates: () => Promise<Map<string, ReconcileFindingRow[]>>;
  writeReviewCost: (reviewId: string, costUsd: number) => Promise<void>;
  now: () => Date;
};

// Look back 30 days: older un-instrumented reviews are not worth re-pricing and
// the window keeps the scan bounded.
const LOOKBACK_DAYS = 30;

async function realLoadCandidates(now: Date): Promise<Map<string, ReconcileFindingRow[]>> {
  const cutoff = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      reviewId: findingStatus.reviewId,
      inputTokensOpus: findingStatus.inputTokensOpus,
      outputTokensOpus: findingStatus.outputTokensOpus,
      inputTokensGpt5: findingStatus.inputTokensGpt5,
      outputTokensGpt5: findingStatus.outputTokensGpt5,
    })
    .from(findingStatus)
    .innerJoin(reviews, sql`${reviews.reviewId} = ${findingStatus.reviewId}`)
    .where(
      and(
        // Patch actually ran for this finding.
        isNotNull(findingStatus.suggestedPatchOpus),
        // Review cost not yet recorded (NULL) or recorded as zero.
        sql`(${reviews.costPatchUsd} IS NULL OR ${reviews.costPatchUsd} = 0)`,
        gte(reviews.createdAt, cutoff),
        lt(reviews.createdAt, now),
      ),
    );

  const byReview = new Map<string, ReconcileFindingRow[]>();
  for (const r of rows) {
    const list = byReview.get(r.reviewId) ?? [];
    list.push({
      inputTokensOpus: r.inputTokensOpus,
      outputTokensOpus: r.outputTokensOpus,
      inputTokensGpt5: r.inputTokensGpt5,
      outputTokensGpt5: r.outputTokensGpt5,
    });
    byReview.set(r.reviewId, list);
  }
  return byReview;
}

async function realWriteReviewCost(reviewId: string, costUsd: number): Promise<void> {
  await db
    .update(reviews)
    .set({ costPatchUsd: costUsd.toFixed(4) })
    .where(sql`${reviews.reviewId} = ${reviewId}`);
}

const defaultDeps: ReconcileDeps = {
  loadCandidates: () => realLoadCandidates(new Date()),
  writeReviewCost: realWriteReviewCost,
  now: () => new Date(),
};

/**
 * Backfill cost_patch_usd for candidate reviews. Returns a summary the cron
 * route logs. Rows whose computed cost is 0 are still written (the heuristic
 * floor is non-zero, so a 0 only happens for an empty/edge candidate) — this
 * keeps the write idempotent and removes the row from future candidate sets.
 */
export async function runPatchCostReconcile(
  deps: ReconcileDeps = defaultDeps,
): Promise<ReconcileSummary> {
  const candidates = await deps.loadCandidates();
  let updated = 0;
  let total = 0;
  for (const [reviewId, findings] of candidates) {
    const cost = reconcileReviewCostUsd(findings);
    await deps.writeReviewCost(reviewId, cost);
    updated += 1;
    total += cost;
  }
  const scanned = candidates.size;
  return {
    reviewsScanned: scanned,
    reviewsUpdated: updated,
    totalEstimatedUsd: Math.round(total * 10_000) / 10_000,
    averagePerReviewUsd: updated === 0 ? 0 : Math.round((total / updated) * 10_000) / 10_000,
  };
}
