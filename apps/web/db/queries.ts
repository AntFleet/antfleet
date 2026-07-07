import { createHash } from "node:crypto";
import { cache } from "react";
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  max,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { db } from "./index";
import {
  agentFindings,
  factoryLaunches,
  findingDisclosure,
  findingDisclosureLog,
  findingValidationEvidenceBundles,
  findingStatus,
  installations,
  maintainerReactions,
  onboardingEvents,
  outgoingPrs,
  reviewGateOutcomes,
  roastSubmissions,
  sarifFinding,
  sarifImportBatch,
  reviews,
  repoThreatModel,
  repoTierChangeLog,
  type AgentFinding,
  type FactoryLaunch,
  type FindingValidationEvidenceBundle,
  type NewAgentFinding,
  type NewFindingDisclosure,
  type NewFindingDisclosureLog,
  type NewFindingValidationEvidenceBundle,
  type NewMaintainerReaction,
  type NewOnboardingEvent,
  type NewReview,
  type NewReviewGateOutcome,
  type NewRepoThreatModel,
  type NewSarifFinding,
  type NewSarifIngestTokenUse,
  type NewSarifImportBatch,
  type OnboardingEvent,
  type RepoThreatModel,
  type RoastSubmission,
  scorecardSnapshots,
  sarifIngestTokenUse,
} from "./schema";
import {
  derivedPublicReceiptCondition,
  reviewDerivedPublicReceiptCondition,
} from "./public-receipt";
import { writePostDraft } from "@/lib/post-drafts";
import { isDisclosureGateEnabled, isCyberTierEnabled } from "@/lib/daybreak-gates-env";
import {
  nonCyberTierRepoCondition,
  nonCyberTierRepoConditionFor,
  nonCyberTierRepoConditionForFullName,
  rawCyberTierExclusionForFullName,
} from "@/lib/cyber-tier";
import { LIFECYCLE_PRESERVE_COLUMNS, reconcilableTrailingRows } from "./finding-lifecycle";
import type { DisclosureActorType, DisclosureState } from "@/lib/disclosure-types";
import { SARIF_TOKEN_USE_GC_BATCH_SIZE } from "@/lib/sarif-token-use-gc";
import { DISMISS_AUTHORISED_ASSOCIATIONS } from "@/lib/precision-feedback-env";

// Hash <owner>/<repo> so the primary index doesn't expose customer identities
// when we publish aggregate metrics. The raw owner/repo can still live inside
// provider_responses JSONB for per-customer queries; the column is the
// privacy boundary. See AGENTS.md §10 "anonymization at write time".
export function hashRepo(owner: string, repo: string): string {
  return createHash("sha256").update(`${owner}/${repo}`).digest("hex");
}

export type RecordReviewInput = Omit<NewReview, "reviewId" | "createdAt" | "costEstimatedUsd"> & {
  costEstimatedUsd: number;
};

export async function recordReview(input: RecordReviewInput): Promise<string> {
  const result = await db
    .insert(reviews)
    .values({
      ...input,
      // pgnumeric expects a string for precise decimal preservation
      costEstimatedUsd: input.costEstimatedUsd.toFixed(4),
    })
    .returning({ reviewId: reviews.reviewId });
  const row = result[0];
  if (row === undefined) {
    throw new Error("recordReview: insert returned no row");
  }
  return row.reviewId;
}

// Mission 7 — idempotent enqueue. The webhook handler inserts the queue
// row on the (repo_hash, pr_number, commit_sha) idempotency key. A duplicate
// GitHub delivery (or a race between cron and webhook) lands on the same
// triple; ON CONFLICT DO NOTHING converts that into a cheap no-op and we
// return the existing reviewId so the caller can still log a delivery and
// (optionally) re-trigger the worker. `isNew=false` is the signal that the
// caller should NOT spawn a fresh after() — the prior delivery owns the row.
export type EnqueueReviewResult = { reviewId: string; isNew: boolean };

export async function enqueueReview(input: RecordReviewInput): Promise<EnqueueReviewResult> {
  const inserted = await db
    .insert(reviews)
    .values({
      ...input,
      costEstimatedUsd: input.costEstimatedUsd.toFixed(4),
      processingStatus: "pending",
      processingAttempts: 0,
    })
    .onConflictDoNothing({
      target: [reviews.repoHash, reviews.prNumber, reviews.commitSha],
    })
    .returning({ reviewId: reviews.reviewId });
  const insertedRow = inserted[0];
  if (insertedRow !== undefined) {
    return { reviewId: insertedRow.reviewId, isNew: true };
  }
  // Conflict path: load the existing row to get its reviewId. The triple is
  // a unique key so this returns 0 or 1 rows.
  const existing = await db
    .select({ reviewId: reviews.reviewId })
    .from(reviews)
    .where(
      and(
        eq(reviews.repoHash, input.repoHash),
        eq(reviews.prNumber, input.prNumber),
        eq(reviews.commitSha, input.commitSha),
      ),
    )
    .limit(1);
  const row = existing[0];
  if (row === undefined) {
    // Race: insert raced with a delete or a constraint mismatch. Fall back
    // to the legacy insert so the caller still gets a row id.
    return { reviewId: await recordReview(input), isNew: true };
  }
  return { reviewId: row.reviewId, isNew: false };
}

// Mission 7 — queue lifecycle. The reviews row IS the queue entry; the
// processing_* columns drive state transitions. Worker calls (webhook
// after() OR cron retry tick) go through `claimReviewForProcessing` to
// atomically take ownership, then `markReviewSucceeded` /
// `markReviewFailedForRetry` / `markReviewTerminallyFailed` to settle.

export const REVIEW_PROCESSING_STATUSES = [
  "pending",
  "in_progress",
  "pending_retry",
  "done",
  "failed",
] as const;
export type ReviewProcessingStatus = (typeof REVIEW_PROCESSING_STATUSES)[number];

// Atomic claim. Caller specifies which prior states are valid to claim from
// — webhook after() passes ["pending"], the retry cron passes
// ["pending", "pending_retry", "in_progress"]. When `in_progress` is in
// fromStatuses, stuckBefore MUST be supplied; the claim then requires
// processingStartedAt < stuckBefore so a second overlapping cron tick
// cannot steal a row that a faster cron tick just freshly claimed.
// Returns true iff the row transitioned to in_progress. False means another
// worker beat us to it — caller should move on without processing.
export async function claimReviewForProcessing(args: {
  reviewId: string;
  fromStatuses: ReadonlyArray<ReviewProcessingStatus>;
  now: Date;
  stuckBefore?: Date;
}): Promise<boolean> {
  if (args.fromStatuses.length === 0) return false;
  // Build the staleness gate. For in_progress claims it's mandatory: the
  // worker reads the row, computes stuckBefore from STUCK_AFTER_MS, and
  // passes it down. The atomic UPDATE then guards against a competing
  // claim that refreshed processing_started_at.
  const includesInProgress = args.fromStatuses.includes("in_progress");
  if (includesInProgress && args.stuckBefore === undefined) {
    throw new Error(
      "claimReviewForProcessing: stuckBefore is required when fromStatuses includes 'in_progress'",
    );
  }
  const stalePredicate =
    args.stuckBefore !== undefined
      ? or(
          ne(reviews.processingStatus, "in_progress"),
          lt(reviews.processingStartedAt, args.stuckBefore),
        )
      : undefined;
  const updated = await db
    .update(reviews)
    .set({
      processingStatus: "in_progress",
      processingStartedAt: args.now,
      processingAttempts: sql`${reviews.processingAttempts} + 1`,
      nextRetryAt: null,
    })
    .where(
      and(
        eq(reviews.reviewId, args.reviewId),
        inArray(reviews.processingStatus, args.fromStatuses as ReviewProcessingStatus[]),
        ...(stalePredicate !== undefined ? [stalePredicate] : []),
      ),
    )
    .returning({ reviewId: reviews.reviewId });
  return updated.length > 0;
}

export type ReviewQueueRow = {
  reviewId: string;
  installationId: number | null;
  owner: string | null;
  repo: string | null;
  prNumber: number;
  commitSha: string;
  repoHash: string;
  prCommentId: number | null;
  processingStatus: string;
  processingAttempts: number;
  processingStartedAt: Date | null;
  publicReceipt: boolean;
  isBenchmark: boolean;
};

export async function loadReviewQueueRow(reviewId: string): Promise<ReviewQueueRow | null> {
  const rows = await db
    .select({
      reviewId: reviews.reviewId,
      installationId: reviews.installationId,
      owner: reviews.owner,
      repo: reviews.repo,
      prNumber: reviews.prNumber,
      commitSha: reviews.commitSha,
      repoHash: reviews.repoHash,
      prCommentId: reviews.prCommentId,
      processingStatus: reviews.processingStatus,
      processingAttempts: reviews.processingAttempts,
      processingStartedAt: reviews.processingStartedAt,
      publicReceipt: reviews.publicReceipt,
      isBenchmark: reviews.isBenchmark,
    })
    .from(reviews)
    .where(eq(reviews.reviewId, reviewId))
    .limit(1);
  return rows[0] ?? null;
}

// Retry-cron data loader. Returns rows eligible for (re)processing under
// three predicates joined by OR:
//   1. processing_status = 'pending' (never started — webhook crashed
//      between insert and after(), or the row was just enqueued)
//   2. processing_status = 'pending_retry' AND next_retry_at <= now
//   3. processing_status = 'in_progress' AND processing_started_at < stuckBefore
//      (a worker claimed but never settled — Vercel cold-killed the function,
//      or our process crashed mid-review)
//
// Rows missing installation_id/owner/repo (M3-1 smoke rows) are excluded —
// the worker has no way to act on them. Rows already terminal ('done' or
// 'failed') are excluded by construction.
// `kind` discriminates the two lifecycle intents that select rows for
// the worker: `due_retry` is a pending or pending_retry row below the
// attempts cap (worker re-runs the pipeline); `stuck_recovery` is an
// in_progress row whose claim has aged past stuckBefore (worker retries
// if below cap, terminalizes if at cap). Returning the intent up to the
// cron layer keeps the two paths legible even though both end up
// dispatched through runReviewWorker.
export type RetryCandidateKind = "due_retry" | "stuck_recovery";

export type RetryCandidate = {
  reviewId: string;
  processingStatus: string;
  processingAttempts: number;
  kind: RetryCandidateKind;
};

export async function loadReviewsReadyForRetry(args: {
  now: Date;
  stuckBefore: Date;
  limit: number;
  maxAttempts: number;
}): Promise<RetryCandidate[]> {
  const rows = await db
    .select({
      reviewId: reviews.reviewId,
      processingStatus: reviews.processingStatus,
      processingAttempts: reviews.processingAttempts,
    })
    .from(reviews)
    .where(
      and(
        // Worker requires these to dispatch.
        isNotNull(reviews.installationId),
        isNotNull(reviews.owner),
        isNotNull(reviews.repo),
        or(
          // Below the attempts cap: eligible for normal retry. Without
          // this bound, a function killed at maxDuration would re-claim
          // forever; with it, only fresh attempts proceed past the cron.
          and(
            lt(reviews.processingAttempts, args.maxAttempts),
            or(
              eq(reviews.processingStatus, "pending"),
              and(
                eq(reviews.processingStatus, "pending_retry"),
                lte(reviews.nextRetryAt, args.now),
              ),
            ),
          ),
          // Stuck in_progress at any attempts count: the worker pre-claim
          // path either retries (if below cap) or terminalizes (if at
          // cap). Without this branch, a row killed mid-attempt at the
          // cap stays in_progress forever, blocking public-API pollers
          // from ever seeing a terminal state.
          and(
            eq(reviews.processingStatus, "in_progress"),
            lt(reviews.processingStartedAt, args.stuckBefore),
          ),
        ),
      ),
    )
    .orderBy(reviews.createdAt)
    .limit(args.limit);
  return rows.map((r) => ({
    ...r,
    kind: r.processingStatus === "in_progress" ? "stuck_recovery" : "due_retry",
  }));
}

export async function markReviewSucceeded(args: { reviewId: string; now: Date }): Promise<void> {
  await db
    .update(reviews)
    .set({
      processingStatus: "done",
      processingFinishedAt: args.now,
      nextRetryAt: null,
      processingError: null,
    })
    .where(eq(reviews.reviewId, args.reviewId));
}

export async function markReviewFailedForRetry(args: {
  reviewId: string;
  nextRetryAt: Date;
  error: string;
}): Promise<void> {
  await db
    .update(reviews)
    .set({
      processingStatus: "pending_retry",
      nextRetryAt: args.nextRetryAt,
      processingError: args.error,
    })
    .where(eq(reviews.reviewId, args.reviewId));
}

export async function markReviewTerminallyFailed(args: {
  reviewId: string;
  now: Date;
  error: string;
}): Promise<void> {
  await db
    .update(reviews)
    .set({
      processingStatus: "failed",
      processingFinishedAt: args.now,
      nextRetryAt: null,
      processingError: args.error,
    })
    .where(eq(reviews.reviewId, args.reviewId));
}

// Atomic terminalize for the attempts-exhausted path. Only marks the row
// failed when it is still genuinely stuck (in_progress + processingStartedAt
// older than stuckBefore + no posted comment + attempts at cap). Returns
// true iff the UPDATE matched. The stuck predicate closes the race where
// overlapping cron ticks observe the same candidate from the loader but
// one of them claims it before the other gets to terminalize: the fresh
// claim resets processingStartedAt, so this UPDATE no longer matches and
// the slower worker correctly backs off.
export async function markReviewExhaustedIfStale(args: {
  reviewId: string;
  maxAttempts: number;
  stuckBefore: Date;
  now: Date;
  error: string;
}): Promise<boolean> {
  const result = await db
    .update(reviews)
    .set({
      processingStatus: "failed",
      processingFinishedAt: args.now,
      nextRetryAt: null,
      processingError: args.error,
    })
    .where(
      and(
        eq(reviews.reviewId, args.reviewId),
        eq(reviews.processingStatus, "in_progress"),
        gte(reviews.processingAttempts, args.maxAttempts),
        lt(reviews.processingStartedAt, args.stuckBefore),
        isNull(reviews.prCommentId),
      ),
    )
    .returning({ reviewId: reviews.reviewId });
  return result.length > 0;
}

// Observability for /api/activity — current queue depth + recent failures.
export type ReviewQueueDepth = {
  pending: number;
  inProgress: number;
  pendingRetry: number;
  failed: number;
};

export async function snapshotReviewQueueDepth(): Promise<ReviewQueueDepth> {
  const rows = await db
    .select({
      processingStatus: reviews.processingStatus,
      total: sql<number>`count(*)::int`.as("total"),
    })
    .from(reviews)
    .where(ne(reviews.processingStatus, "done"))
    .groupBy(reviews.processingStatus);
  const out: ReviewQueueDepth = { pending: 0, inProgress: 0, pendingRetry: 0, failed: 0 };
  for (const r of rows) {
    if (r.processingStatus === "pending") out.pending = r.total;
    else if (r.processingStatus === "in_progress") out.inProgress = r.total;
    else if (r.processingStatus === "pending_retry") out.pendingRetry = r.total;
    else if (r.processingStatus === "failed") out.failed = r.total;
  }
  return out;
}

// Post-review patch: slice 4b writes a stub row up front, then updates it
// with real per-provider output + agreement decision once the pipeline
// completes. Only the columns that change post-review are accepted.
export type UpdateReviewInput = {
  filesReviewed?: string[];
  providerModelIds?: unknown;
  providerResponses?: unknown;
  agreementDecision?: unknown;
  timingMs?: number;
  costEstimatedUsd?: number;
  // Cyber-tier materialization (architect audit pass-4): the worker
  // must be able to force publicReceipt=false at processing time when
  // a repo flips to cyber after enqueue. Without this column, an
  // enqueue-default → flip-cyber → flip-back sequence would leave the
  // row's publicReceipt=true even though the review ran under cyber.
  publicReceipt?: boolean;
};

export async function updateReview(reviewId: string, input: UpdateReviewInput): Promise<void> {
  const values: Record<string, unknown> = { ...input };
  if (input.costEstimatedUsd !== undefined) {
    values["costEstimatedUsd"] = input.costEstimatedUsd.toFixed(4);
  }
  await db.update(reviews).set(values).where(eq(reviews.reviewId, reviewId));
}

// Mission 3 lifecycle helpers — Slice 1 (this commit) persists what Slice 2+
// will reconcile. Sweeper queries finding_status by status='open', so storing
// the right reviewId + findingIndex + denormalized title/severity is enough
// for the reconciliation loop to find work later.

/**
 * Stable id format: `<reviewId>-<findingIndex>`.
 *
 * Round-5 audit caught that the previous 8-character-prefix shape (~32
 * bits of entropy from a UUIDv4) admits birthday collisions at ~65k
 * reviews. recordFindingStatuses uses onConflictDoUpdate on this column,
 * so a collision would silently overwrite the FIRST review's lifecycle
 * row when the SECOND review's worker upserts. Embed the full reviewId
 * to make the unique key collision-proof.
 *
 * Existing rows (written under the old format) stay valid as text; new
 * rows are forward-only in the longer form. Downstream consumers parse
 * trailing `-<digits>` for the index (e.g. cleanup scripts) so both
 * shapes split correctly.
 */
export function makeFindingId(reviewId: string, findingIndex: number): string {
  return `${reviewId}-${findingIndex}`;
}

export async function setReviewComment(args: {
  reviewId: string;
  commentId: number;
  commentUrl: string;
}): Promise<void> {
  await db
    .update(reviews)
    .set({ prCommentId: args.commentId, prCommentUrl: args.commentUrl })
    .where(eq(reviews.reviewId, args.reviewId));
}

export type FindingLifecycleInput = {
  title: string;
  severity: string;
  label?: string | null;
  category: string;
};

export async function recordFindingStatuses(
  reviewId: string,
  agreed: FindingLifecycleInput[],
): Promise<string[]> {
  const rows = agreed.map((f, index) => ({
    reviewId,
    findingIndex: index,
    findingId: makeFindingId(reviewId, index),
    title: f.title,
    severity: f.severity,
    label: f.label ?? "blocking",
    category: f.category,
  }));
  // Reconcile carefully on retry. Three constraints:
  //   1. Idempotent for identical replays — same input must yield the
  //      same returned findingIds.
  //   2. Honour a changed retried bundle — if the second LLM attempt
  //      produced different titles at the same (reviewId, index), the
  //      PR comment now shows the new text, so the DB must too.
  //   3. NEVER erase lifecycle state another worker already mutated.
  //      The sweeper writes closure_sha / closure_comment_id; the patch
  //      lane writes patch_review_comment_id / patch_accepted_sha. A
  //      blunt delete-then-insert (round-2 shape) would lose those if
  //      the worker re-entered recordFindingStatuses after the sweeper
  //      had acted (e.g. postPRComment succeeded but setReviewComment
  //      failed, the row stayed in_progress, and a retry re-ran the
  //      pre-comment write).
  return await db.transaction(async (tx) => {
    // Preselect every existing row for this reviewId so we can REUSE
    // each row's existing finding_id text in the insert. This:
    //   - Lets the upsert target finding_id (already UNIQUE pre-0038)
    //     without depending on the natural-key migration being applied
    //     before this code ships.
    //   - Keeps legacy short-format finding_ids stable across a retry
    //     so downstream tables that FK by finding_id text
    //     (maintainer_reactions, patch decisions, patch review comment)
    //     continue to match.
    const existing = await tx
      .select({
        findingIndex: findingStatus.findingIndex,
        findingId: findingStatus.findingId,
        status: findingStatus.status,
      })
      .from(findingStatus)
      .where(eq(findingStatus.reviewId, reviewId));
    const existingByIndex = new Map(existing.map((r) => [r.findingIndex, r]));
    const reconciledRows = rows.map((r) => ({
      ...r,
      findingId: existingByIndex.get(r.findingIndex)?.findingId ?? r.findingId,
    }));
    if (reconciledRows.length > 0) {
      // Only update identity (title/severity/label/category) when the
      // existing row is still untouched. A row that has lifecycle
      // history (closure, patch artefacts, retraction) keeps its
      // current identity so a retry can't attach old closure metadata
      // to a different LLM finding at the same index. The preserve
      // predicate is the same one used by reconcilableTrailingRows so
      // the two paths agree on what "untouched" means.
      await tx
        .insert(findingStatus)
        .values(reconciledRows)
        .onConflictDoUpdate({
          target: findingStatus.findingId,
          set: {
            title: sql`excluded.title`,
            severity: sql`excluded.severity`,
            label: sql`excluded.label`,
            category: sql`excluded.category`,
          },
          where: and(
            eq(findingStatus.status, "open"),
            ...LIFECYCLE_PRESERVE_COLUMNS.map((c) => isNull(c)),
          ),
        });
    }
    // Delete trailing rows beyond the new length, but only when they
    // are still "untouched". The preserve predicate is owned by
    // ./finding-lifecycle so the LIFECYCLE_PRESERVE_COLUMNS list stays
    // beside the schema and is a single audit point when a new
    // lifecycle column is added.
    await tx.delete(findingStatus).where(reconcilableTrailingRows(reviewId, rows.length));
    if (rows.length === 0) return [];
    const out = await tx
      .select({ findingId: findingStatus.findingId })
      .from(findingStatus)
      .where(and(eq(findingStatus.reviewId, reviewId), lt(findingStatus.findingIndex, rows.length)))
      .orderBy(findingStatus.findingIndex);
    return out.map((r) => r.findingId);
  });
}

// Patch Agent v1.5 — persist the per-finding patch decision into
// finding_status. Called once per agreed finding immediately after the
// patch agreement gate runs (PR3) but BEFORE the PR comment is posted
// (PR4). All fields are nullable so a flag-off run writes nothing.
//
// Idempotent by findingId — re-running the worker on a transient failure
// re-applies the same write; UPDATE … WHERE finding_id = X is a no-op
// when called twice with the same values.
export type RecordPatchDecisionInput = {
  findingId: string;
  // The unified-diff text the gate selected, or null when no patch shipped.
  suggestedPatch: string | null;
  // Provider model id whose patch shipped (claude-opus-4-7 in v1). Null
  // when no patch shipped.
  patchModelId: string | null;
  // models_disagreed / outside_diff_hunk / generation_error / disabled /
  // size_cap. Non-null exactly when suggestedPatch is null.
  patchSkipReason: string | null;
  // Patch generation cost for this finding, in USD. Aggregated into
  // reviews.costPatchUsd at the worker layer; not persisted per-finding
  // (the column lives on reviews, not finding_status). Accepted here only
  // so the caller can hand the gate's output back unmodified — we ignore
  // it for the SQL write.
  proposedAt: Date;
  // Eval Phase 0 — dual-candidate persistence.
  candidates: { opus: string | null; gpt5: string | null };
  rationales?: { opus: string | null; gpt5: string | null };
  // Migration 0035 — per-side raw orchestrator skip reason. Optional like
  // `tokens` and `rationales`: callers that omit it get NULL writes (the
  // existing aggregate patch_skip_reason column above continues to land).
  skipReasons?: { opus: string | null; gpt5: string | null };
  selector:
    | "deterministic-opus"
    | "no-opus-deterministic-skip"
    | "no-gpt5-deterministic-skip"
    | "no-candidates";
  // Migration 0029 — per-finding patch-proposal token spend, split by
  // provider. Null when that provider made no billable call for the finding.
  tokens?: {
    inputTokensOpus: number | null;
    outputTokensOpus: number | null;
    inputTokensGpt5: number | null;
    outputTokensGpt5: number | null;
  };
};

export async function recordPatchDecisions(
  inputs: readonly RecordPatchDecisionInput[],
): Promise<void> {
  if (inputs.length === 0) return;
  // Drizzle has no native batched UPDATE; run them in parallel. The
  // cardinality is bounded by findings-per-review (low single digits
  // in practice).
  await Promise.all(inputs.map((i) => recordOnePatchDecision(i)));
}

async function recordOnePatchDecision(i: RecordPatchDecisionInput): Promise<void> {
  await db
    .update(findingStatus)
    .set({
      // Existing writes — UNCHANGED (backward compat for sweeper + click-apply reads)
      suggestedPatch: i.suggestedPatch,
      patchModelId: i.patchModelId,
      patchSkipReason: i.patchSkipReason,
      patchProposedAt: i.proposedAt,
      // Eval Phase 0 — new writes
      suggestedPatchOpus: i.candidates.opus,
      suggestedPatchGpt5: i.candidates.gpt5,
      patchShipped: i.suggestedPatch,
      patchSelector: i.selector,
      // Migration 0029 — per-finding token spend (null when absent so we
      // never clobber an existing value with undefined on a partial input).
      ...(i.tokens !== undefined
        ? {
            inputTokensOpus: i.tokens.inputTokensOpus,
            outputTokensOpus: i.tokens.outputTokensOpus,
            inputTokensGpt5: i.tokens.inputTokensGpt5,
            outputTokensGpt5: i.tokens.outputTokensGpt5,
          }
        : {}),
    })
    .where(eq(findingStatus.findingId, i.findingId));

  try {
    await db
      .update(findingStatus)
      .set({
        patchRationaleOpus: i.rationales?.opus ?? null,
        patchRationaleGpt5: i.rationales?.gpt5 ?? null,
      })
      .where(eq(findingStatus.findingId, i.findingId));
  } catch (err) {
    if (!isMissingPatchRationaleColumnError(err)) throw err;
  }

  try {
    await db
      .update(findingStatus)
      .set({
        patchSkipReasonOpus: i.skipReasons?.opus ?? null,
        patchSkipReasonGpt5: i.skipReasons?.gpt5 ?? null,
      })
      .where(eq(findingStatus.findingId, i.findingId));
  } catch (err) {
    if (!isMissingPatchSkipReasonColumnError(err)) throw err;
  }
}

export function isMissingPatchRationaleColumnError(err: unknown): boolean {
  const maybe = err as { code?: unknown; message?: unknown };
  if (maybe.code !== "42703") return false;
  const message = typeof maybe.message === "string" ? maybe.message : "";
  return message.includes("patch_rationale_opus") || message.includes("patch_rationale_gpt5");
}

export function isMissingPatchSkipReasonColumnError(err: unknown): boolean {
  const maybe = err as { code?: unknown; message?: unknown };
  if (maybe.code !== "42703") return false;
  const message = typeof maybe.message === "string" ? maybe.message : "";
  return message.includes("patch_skip_reason_opus") || message.includes("patch_skip_reason_gpt5");
}

// Patch Agent v1.6 — persist the PR review-comment artifact id/url after
// the worker posts the suggestion as a line-anchored comment. Idempotent
// on retry via `WHERE patch_review_comment_id IS NULL` so a worker rerun
// after a partial-failure does not double-post (the post happens BEFORE
// this write; if the post succeeded but this write failed, retry would
// post again — accepted tradeoff; the orphan comment is harmless).
export type RecordPatchReviewCommentInput = {
  findingId: string;
  reviewCommentId: number;
  reviewCommentUrl: string;
  proposedAt: Date;
};

export async function recordPatchReviewComment(
  input: RecordPatchReviewCommentInput,
): Promise<void> {
  await db
    .update(findingStatus)
    .set({
      patchReviewCommentId: input.reviewCommentId,
      patchReviewCommentUrl: input.reviewCommentUrl,
      patchReviewProposedAt: input.proposedAt,
    })
    .where(
      and(eq(findingStatus.findingId, input.findingId), isNull(findingStatus.patchReviewCommentId)),
    );
}

// Patch Agent v1.5 — observability-only patch cost write. costPatchUsd
// lives on the reviews row (one number per review). Drawdown is unaffected.
export async function setReviewPatchCost(reviewId: string, costPatchUsd: number): Promise<void> {
  await db
    .update(reviews)
    .set({ costPatchUsd: costPatchUsd.toFixed(4) })
    .where(eq(reviews.reviewId, reviewId));
}

// Retraction surface (migration 0030). Operator-driven: stamp retracted_at +
// reason (+ requestor email when known) on a finding so its /anatomy page
// flips to the retracted state. Idempotent on retracted_at IS NULL — a
// re-retraction does not overwrite the original timestamp/reason, so the first
// retraction is the durable one. Returns true when a (still-live) row was
// retracted, false when the finding id is unknown OR already retracted; the
// caller maps false to 404 so the operator notices a typo'd id.
export async function retractFinding(
  findingId: string,
  reason: string,
  requestorEmail: string | null,
): Promise<boolean> {
  const updated = await db
    .update(findingStatus)
    .set({
      retractedAt: new Date(),
      retractionReason: reason,
      retractionEmail: requestorEmail,
    })
    .where(and(eq(findingStatus.findingId, findingId), isNull(findingStatus.retractedAt)))
    .returning({ findingId: findingStatus.findingId });
  return updated.length > 0;
}

// Patch Agent v1.5 — sweeper patch-acceptance work loader. Returns one row
// per finding that has a proposed patch but no acceptance yet, joined to
// the parent review so the sweep pass has install + repo context to read
// HEAD content. Rows are dropped silently when the parent review is
// missing dispatch fields (same pattern as loadSweepWork).
export type PatchAcceptanceCandidate = {
  findingId: string;
  reviewId: string;
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  prCommentUrl: string | null;
  suggestedPatch: string;
  patchModelId: string | null;
  // Path the suggestion targets — extracted from the JSONB agreement_decision
  // at the finding's index. Falls back to the patch's "+++ b/..." header
  // when JSONB lookup fails; null when neither yields a path.
  evidencePath: string | null;
};

export async function loadPatchAcceptanceWork(): Promise<PatchAcceptanceCandidate[]> {
  const rows = await db
    .select({
      findingId: findingStatus.findingId,
      findingIndex: findingStatus.findingIndex,
      reviewId: findingStatus.reviewId,
      suggestedPatch: findingStatus.suggestedPatch,
      patchModelId: findingStatus.patchModelId,
      installationId: reviews.installationId,
      owner: reviews.owner,
      repo: reviews.repo,
      prNumber: reviews.prNumber,
      prCommentUrl: reviews.prCommentUrl,
      agreementDecision: reviews.agreementDecision,
    })
    .from(findingStatus)
    .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
    .where(
      and(
        isNotNull(findingStatus.patchProposedAt),
        sql`${findingStatus.patchAcceptedAt} IS NULL`,
        isNotNull(findingStatus.suggestedPatch),
      ),
    );

  const out: PatchAcceptanceCandidate[] = [];
  for (const r of rows) {
    if (
      r.installationId === null ||
      r.owner === null ||
      r.repo === null ||
      r.suggestedPatch === null
    )
      continue;
    out.push({
      findingId: r.findingId,
      reviewId: r.reviewId,
      installationId: r.installationId,
      owner: r.owner,
      repo: r.repo,
      prNumber: r.prNumber,
      prCommentUrl: r.prCommentUrl,
      suggestedPatch: r.suggestedPatch,
      patchModelId: r.patchModelId,
      evidencePath:
        extractEvidencePathFromAgreement(r.agreementDecision, r.findingIndex) ??
        extractPathFromPatch(r.suggestedPatch),
    });
  }
  return out;
}

// Patch Agent v1.5 — sweeper acceptance write. Sets patch_accepted_at + sha
// when the sweep pass detects the suggestion's new-side content in HEAD.
// Idempotent at the DB layer (re-running won't overwrite a prior write
// because the loader filters out rows where patchAcceptedAt is non-null).
export async function markPatchAccepted(args: {
  findingId: string;
  acceptedSha: string;
  now: Date;
}): Promise<void> {
  await db
    .update(findingStatus)
    .set({
      patchAcceptedAt: args.now,
      patchAcceptedSha: args.acceptedSha,
    })
    .where(eq(findingStatus.findingId, args.findingId));
}

// Patch Agent v1.6 — sweeper click-apply detection candidate set. Selects
// finding_status rows where a PR review comment was posted (v1.6 path)
// but the click-apply transition has not been observed yet. The heuristic
// the sweeper applies: re-fetch the review comment, see if its commit_id
// has advanced beyond the post-time SHA, then verify the suggested patch's
// new-side content appears at the anchor file at the new SHA.
export type PatchReviewCommentCandidate = {
  findingId: string;
  reviewId: string;
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  prCommentUrl: string | null;
  suggestedPatch: string;
  patchModelId: string | null;
  evidencePath: string | null;
  // 1-based new-side line the review comment was anchored to. Carried
  // through so the click-apply sweep pass can do an anchor-bound content
  // match (vs the v1.5 whole-file scan). Null when the agreement JSONB
  // lacks a numeric startLine — sweep treats null as "skip", because
  // anchor-bound is the whole point of the v1.6 detection.
  evidenceStartLine: number | null;
  reviewCommentId: number;
  reviewCommentUrl: string | null;
};

export async function loadPatchReviewCommentAcceptanceWork(): Promise<
  PatchReviewCommentCandidate[]
> {
  const rows = await db
    .select({
      findingId: findingStatus.findingId,
      findingIndex: findingStatus.findingIndex,
      reviewId: findingStatus.reviewId,
      suggestedPatch: findingStatus.suggestedPatch,
      patchModelId: findingStatus.patchModelId,
      reviewCommentId: findingStatus.patchReviewCommentId,
      reviewCommentUrl: findingStatus.patchReviewCommentUrl,
      installationId: reviews.installationId,
      owner: reviews.owner,
      repo: reviews.repo,
      prNumber: reviews.prNumber,
      prCommentUrl: reviews.prCommentUrl,
      agreementDecision: reviews.agreementDecision,
    })
    .from(findingStatus)
    .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
    .where(
      and(
        isNotNull(findingStatus.patchReviewCommentId),
        isNull(findingStatus.patchApplyClickedAt),
        isNotNull(findingStatus.suggestedPatch),
      ),
    );

  const out: PatchReviewCommentCandidate[] = [];
  for (const r of rows) {
    if (
      r.installationId === null ||
      r.owner === null ||
      r.repo === null ||
      r.suggestedPatch === null ||
      r.reviewCommentId === null
    )
      continue;
    out.push({
      findingId: r.findingId,
      reviewId: r.reviewId,
      installationId: r.installationId,
      owner: r.owner,
      repo: r.repo,
      prNumber: r.prNumber,
      prCommentUrl: r.prCommentUrl,
      suggestedPatch: r.suggestedPatch,
      patchModelId: r.patchModelId,
      evidencePath:
        extractEvidencePathFromAgreement(r.agreementDecision, r.findingIndex) ??
        extractPathFromPatch(r.suggestedPatch),
      evidenceStartLine: extractEvidenceStartLineFromAgreement(r.agreementDecision, r.findingIndex),
      reviewCommentId: r.reviewCommentId,
      reviewCommentUrl: r.reviewCommentUrl,
    });
  }
  return out;
}

// Patch Agent v1.6 — sweeper click-apply detection write. Sets
// patch_apply_clicked_at when the review-comment poll detects the
// suggestion has been applied via GitHub's "Commit suggestion" button.
// Idempotent on retry: the loader filters out rows where the column
// is non-null, AND the UPDATE predicate also enforces it for the rare
// case where two sweep ticks race (the second is a no-op).
export async function markPatchApplyClicked(args: { findingId: string; now: Date }): Promise<void> {
  await db
    .update(findingStatus)
    .set({ patchApplyClickedAt: args.now })
    .where(
      and(eq(findingStatus.findingId, args.findingId), isNull(findingStatus.patchApplyClickedAt)),
    );
}

function extractEvidencePathFromAgreement(
  agreementDecision: unknown,
  findingIndex: number,
): string | null {
  const ev = extractEvidenceEntryFromAgreement(agreementDecision, findingIndex);
  if (ev === null) return null;
  const p = ev["path"];
  return typeof p === "string" ? safeRepoRelativePath(p) : null;
}

// Patch Agent v1.6 — pull startLine off the same evidence entry so the
// click-apply detection pass can anchor its content match to a specific
// line. Returns null when the JSONB is malformed or the finding has no
// numeric startLine.
function extractEvidenceStartLineFromAgreement(
  agreementDecision: unknown,
  findingIndex: number,
): number | null {
  const ev = extractEvidenceEntryFromAgreement(agreementDecision, findingIndex);
  if (ev === null) return null;
  const sl = ev["startLine"];
  return typeof sl === "number" && Number.isInteger(sl) && sl > 0 ? sl : null;
}

function extractEvidenceEntryFromAgreement(
  agreementDecision: unknown,
  findingIndex: number,
): Record<string, unknown> | null {
  if (typeof agreementDecision !== "object" || agreementDecision === null) return null;
  const obj = agreementDecision as Record<string, unknown>;
  const agreed = obj["agreed"];
  if (!Array.isArray(agreed)) return null;
  const finding = agreed[findingIndex];
  if (typeof finding !== "object" || finding === null) return null;
  const evidence = (finding as Record<string, unknown>)["evidence"];
  if (!Array.isArray(evidence) || evidence.length === 0) return null;
  const first = evidence[0];
  if (typeof first !== "object" || first === null) return null;
  return first as Record<string, unknown>;
}

// Liberalized to handle the unified-diff variants we see in practice:
//   +++ b/path/to/file.ts   (git default)
//   +++ a/path/to/file.ts   (some tools)
//   +++ ./path/to/file.ts   (LLM-emitted)
//   +++ path/to/file.ts     (no prefix)
// The path is then validated against safeRepoRelativePath to reject
// traversal / absolute / null-byte payloads — this fallback is LLM-
// controlled and flows into octokit.repos.getContent.
export function extractPathFromPatch(patch: string): string | null {
  const match = /^\+\+\+ (?:[ab]\/|\.\/)?(.+?)\s*$/mu.exec(patch);
  const raw = match?.[1];
  if (raw === undefined) return null;
  return safeRepoRelativePath(raw);
}

// Validates a path is safe to hand to GitHub's getContent API. Returns
// the cleaned path or null if the input contains traversal, absolute-
// path prefix, or NUL byte. Defense in depth: the install token already
// scopes blast radius to the install's repos, but a hallucinated
// `../../etc/passwd` in an LLM patch header should not reach the API.
export function safeRepoRelativePath(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes("\0")) return null;
  if (trimmed.startsWith("/")) return null;
  // Reject any segment containing `..` — covers `..`, `../`, `a/../b`.
  // Split on / and \ to catch the Windows-style spelling too.
  for (const segment of trimmed.split(/[\\/]/u)) {
    if (segment === ".." || segment === "..\\") return null;
  }
  // /dev/null is a unified-diff convention for "deleted on this side";
  // not a real file path, reject explicitly.
  if (trimmed === "dev/null") return null;
  return trimmed;
}

// Mission 3 slices 2-3 — Sweeper marks a finding closed when the evidence
// file has changed on the default branch since the review's commit_sha.
// Slice 3 extends the helper to optionally record the closure-receipt
// comment id/url in the same write so the slice 3-5 cron loop can transition
// a finding from "open" → "closed + receipted" in one DB round-trip.
export async function markFindingClosed(args: {
  findingId: string;
  closureSha: string;
  closureCommentId?: number;
  closureCommentUrl?: string;
}): Promise<void> {
  const values: Record<string, unknown> = {
    status: "closed",
    closureSha: args.closureSha,
    closureDetectedAt: new Date(),
  };
  if (args.closureCommentId !== undefined) {
    values["closureCommentId"] = args.closureCommentId;
  }
  if (args.closureCommentUrl !== undefined) {
    values["closureCommentUrl"] = args.closureCommentUrl;
  }
  await db.update(findingStatus).set(values).where(eq(findingStatus.findingId, args.findingId));
}

// Mission 3 slice 3-5 — sweep orchestrator data loader. Joins finding_status
// (status='open') against the parent reviews row and returns one batch per
// review so the orchestrator can group GitHub API calls by repo. Rows whose
// review is missing any of installation_id/owner/repo (e.g. the M3-1 smoke
// rows that predate the 0003 migration) are silently dropped — the
// orchestrator has no way to act on them and they don't represent
// production-shape state going forward.
export type SweepFinding = {
  findingId: string;
  findingIndex: number;
  prCommentId: number | null;
  publicReceiptEligible: boolean;
  createdAt: Date;
  lastPolledAt: Date | null;
};

export type SweepReviewBatch = {
  reviewId: string;
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  prCommentId: number | null;
  prCommentUrl: string | null;
  agreementDecision: unknown;
  findings: SweepFinding[];
};

export async function loadSweepWork(): Promise<SweepReviewBatch[]> {
  // The join is the readable shape — for v1 cardinality (low review volume),
  // a join + JS grouping is cheaper to read and identical in cost to the
  // two-query variant. Revisit if the per-review fan-out grows.
  const rows = await db
    .select({
      reviewId: reviews.reviewId,
      installationId: reviews.installationId,
      owner: reviews.owner,
      repo: reviews.repo,
      prNumber: reviews.prNumber,
      commitSha: reviews.commitSha,
      prCommentId: reviews.prCommentId,
      prCommentUrl: reviews.prCommentUrl,
      agreementDecision: reviews.agreementDecision,
      findingId: findingStatus.findingId,
      findingIndex: findingStatus.findingIndex,
      publicReceiptEligible: sql<boolean>`(
        (
            ${findingDisclosure.state} = 'published'
            AND (
              (
                ${findingDisclosure.ghsaId} IS NULL
                AND ${findingStatus.closureCommentUrl} IS NOT NULL
              )
              OR (
                ${findingDisclosure.ghsaId} IS NOT NULL
                AND ${findingDisclosure.ghsaPublishedAt} IS NOT NULL
                AND ${findingDisclosure.ghsaHtmlUrl} IS NOT NULL
              )
            )
          )
        OR (
          ${findingDisclosure.state} = 'none'
          AND ${reviews.publicReceipt} = true
        )
      )`.as("publicReceiptEligible"),
      findingCreatedAt: findingStatus.createdAt,
      findingLastPolledAt: findingStatus.lastPolledAt,
    })
    .from(findingStatus)
    .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
    .leftJoin(findingDisclosure, eq(findingDisclosure.findingId, findingStatus.findingId))
    .where(
      and(
        eq(findingStatus.status, "open"),
        // Only sweep findings whose parent review has actually posted its
        // PR comment. Without this gate, the sweeper races the worker: a
        // worker that wrote finding_status before postPRComment then died
        // (setReviewComment never persisted prCommentId) would leave
        // findings the sweeper can pick up and close — even though the
        // worker is about to retry and overwrite the identity. Closing
        // a stale-identity finding then attaches closure metadata to a
        // different LLM finding when the retry lands.
        or(
          isNotNull(reviews.prCommentId),
          inArray(findingDisclosure.state, [
            "embargoed",
            "maintainer-acknowledged",
            "patch-merged",
            "embargo-expired",
          ]),
        ),
      ),
    );

  const byReview = new Map<string, SweepReviewBatch>();
  for (const r of rows) {
    if (r.installationId === null || r.owner === null || r.repo === null) continue;
    let batch = byReview.get(r.reviewId);
    if (batch === undefined) {
      batch = {
        reviewId: r.reviewId,
        installationId: r.installationId,
        owner: r.owner,
        repo: r.repo,
        prNumber: r.prNumber,
        commitSha: r.commitSha,
        prCommentId: r.prCommentId,
        prCommentUrl: r.prCommentUrl,
        agreementDecision: r.agreementDecision,
        findings: [],
      };
      byReview.set(r.reviewId, batch);
    }
    batch.findings.push({
      findingId: r.findingId,
      findingIndex: r.findingIndex,
      prCommentId: r.prCommentId,
      publicReceiptEligible: r.publicReceiptEligible === true,
      createdAt: r.findingCreatedAt,
      lastPolledAt: r.findingLastPolledAt,
    });
  }
  return Array.from(byReview.values());
}

export async function stampFindingPolled(findingId: string, now: Date): Promise<void> {
  await db
    .update(findingStatus)
    .set({ lastPolledAt: now })
    .where(eq(findingStatus.findingId, findingId));
}

// Mission 3 slice 3-4 — reaction polling DB helper. GitHub returns the full
// list of reactions on every poll, so we accept that we'll re-attempt the
// same rows repeatedly and let the unique index drop the duplicates. Returns
// the count of rows actually inserted so the slice 3-5 cron handler can
// report a meaningful "reactionsRecorded" counter.
// Mission 4 slice 4-3 / 4-5 — the public /receipts page. Receipts are the
// moat (§18.2): a third-party-witnessed, growing audit trail of every closed
// finding. The page reads finding_status WHERE status='closed' joined to
// reviews for repo_hash + pr_number, gated by reviews.public_receipt = true
// (slice 4-5: opt-in per install, default false, see schema comment).
// owner/repo are not selected: only the already-anonymized repo_hash crosses
// this boundary (§10 / §18.3). The closure_comment_url itself does contain
// owner/repo for installs on public repos — that is intentional and
// load-bearing: the URL IS the receipt, and the third-party witness only
// counts because anyone can click and verify it on GitHub. For private-repo
// installs, the URL auth-walls naturally.
export type PublicReceiptRow = {
  findingId: string;
  severity: string;
  label: string | null;
  category: string;
  title: string;
  repoHash: string;
  prNumber: number;
  closureSha: string | null;
  closureCommentUrl: string | null;
  ghsaHtmlUrl: string | null;
  closedAt: Date | null;
};

export type PublicReceiptsPage = {
  totalClosed: number;
  recent: PublicReceiptRow[];
  lastUpdatedAt: Date | null;
  hasMore: boolean;
};

export async function loadPublicReceiptsPage(args: {
  limit: number;
  // Cursor for older-than pagination. Pass the closedAt of the last row on
  // the current page; the next page returns rows strictly older than it.
  // Stable under inserts because closures append at the top, not the middle.
  before?: Date | undefined;
}): Promise<PublicReceiptsPage> {
  const disclosureGateEnabled = isDisclosureGateEnabled();
  // Fetch limit+1 so we can answer hasMore without a second count query.
  const fetchLimit = args.limit + 1;
  // Gate condition is identical across all three queries — closed findings
  // attached to reviews flagged for public visibility. Inlined per-query
  // because the count and max queries need the join too.
  // Retracted findings drop out of the public feed AND the headline count —
  // the count must match the rows behind it, and a retracted finding's title
  // must not keep appearing in the list (it stays live only as a notice on its
  // own /anatomy + /receipts/{id} page).
  const recentConditions =
    args.before === undefined
      ? and(
          eq(findingStatus.status, "closed"),
          disclosureGateEnabled ? derivedPublicReceiptCondition : eq(reviews.publicReceipt, true),
          nonCyberTierRepoCondition(),
          isNull(findingStatus.retractedAt),
        )
      : and(
          eq(findingStatus.status, "closed"),
          disclosureGateEnabled ? derivedPublicReceiptCondition : eq(reviews.publicReceipt, true),
          nonCyberTierRepoCondition(),
          isNull(findingStatus.retractedAt),
          lt(findingStatus.closureDetectedAt, args.before),
        );

  const totalConditions = and(
    eq(findingStatus.status, "closed"),
    disclosureGateEnabled ? derivedPublicReceiptCondition : eq(reviews.publicReceipt, true),
    nonCyberTierRepoCondition(),
    isNull(findingStatus.retractedAt),
  );

  const [countRows, fetchedRows, lastUpdatedRows] = await Promise.all([
    disclosureGateEnabled
      ? db
          .select({ value: count() })
          .from(findingStatus)
          .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
          .leftJoin(findingDisclosure, eq(findingDisclosure.findingId, findingStatus.findingId))
          .where(totalConditions)
      : db
          .select({ value: count() })
          .from(findingStatus)
          .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
          .where(totalConditions),
    disclosureGateEnabled
      ? db
          .select({
            findingId: findingStatus.findingId,
            severity: findingStatus.severity,
            label: findingStatus.label,
            category: findingStatus.category,
            title: findingStatus.title,
            repoHash: reviews.repoHash,
            prNumber: reviews.prNumber,
            closureSha: findingStatus.closureSha,
            closureCommentUrl: findingStatus.closureCommentUrl,
            ghsaHtmlUrl: findingDisclosure.ghsaHtmlUrl,
            closedAt: findingStatus.closureDetectedAt,
          })
          .from(findingStatus)
          .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
          .leftJoin(findingDisclosure, eq(findingDisclosure.findingId, findingStatus.findingId))
          .where(recentConditions)
          .orderBy(desc(findingStatus.closureDetectedAt))
          .limit(fetchLimit)
      : db
          .select({
            findingId: findingStatus.findingId,
            severity: findingStatus.severity,
            label: findingStatus.label,
            category: findingStatus.category,
            title: findingStatus.title,
            repoHash: reviews.repoHash,
            prNumber: reviews.prNumber,
            closureSha: findingStatus.closureSha,
            closureCommentUrl: findingStatus.closureCommentUrl,
            ghsaHtmlUrl: sql<string | null>`NULL`.as("ghsaHtmlUrl"),
            closedAt: findingStatus.closureDetectedAt,
          })
          .from(findingStatus)
          .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
          .where(recentConditions)
          .orderBy(desc(findingStatus.closureDetectedAt))
          .limit(fetchLimit),
    disclosureGateEnabled
      ? db
          .select({ value: max(findingStatus.closureDetectedAt) })
          .from(findingStatus)
          .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
          .leftJoin(findingDisclosure, eq(findingDisclosure.findingId, findingStatus.findingId))
          .where(totalConditions)
      : db
          .select({ value: max(findingStatus.closureDetectedAt) })
          .from(findingStatus)
          .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
          .where(totalConditions),
  ]);

  const hasMore = fetchedRows.length > args.limit;
  const recent = hasMore ? fetchedRows.slice(0, args.limit) : fetchedRows;
  const lastUpdatedRaw = lastUpdatedRows[0]?.value ?? null;
  // drizzle returns max() as a string for timestamp columns over neon-http.
  const lastUpdatedAt =
    lastUpdatedRaw === null
      ? null
      : lastUpdatedRaw instanceof Date
        ? lastUpdatedRaw
        : new Date(lastUpdatedRaw);

  return {
    totalClosed: countRows[0]?.value ?? 0,
    recent,
    lastUpdatedAt,
    hasMore,
  };
}

// Window-bounded top-closures helper for the weekly /digest/[date]
// permalink. Returns the N highest-severity public receipts whose
// closure landed inside [since, until). Ranking is done in JS (info <
// low < med < high) since the weekly window is small enough that
// fetching the whole set and sorting is cheaper than a CASE expression
// the optimizer can't index. Tie-breaks on closureDetectedAt DESC so
// same-severity siblings stay newest-first.
export async function loadTopClosuresBetween(
  since: Date,
  until: Date,
  limit: number,
): Promise<PublicReceiptRow[]> {
  if (until.getTime() <= since.getTime() || limit <= 0) return [];
  const disclosureGateEnabled = isDisclosureGateEnabled();
  const baseConditions = and(
    eq(findingStatus.status, "closed"),
    disclosureGateEnabled ? derivedPublicReceiptCondition : eq(reviews.publicReceipt, true),
    nonCyberTierRepoCondition(),
    gte(findingStatus.closureDetectedAt, since),
    lt(findingStatus.closureDetectedAt, until),
  );
  const rows = await (disclosureGateEnabled
    ? db
        .select({
          findingId: findingStatus.findingId,
          severity: findingStatus.severity,
          label: findingStatus.label,
          category: findingStatus.category,
          title: findingStatus.title,
          repoHash: reviews.repoHash,
          prNumber: reviews.prNumber,
          closureSha: findingStatus.closureSha,
          closureCommentUrl: findingStatus.closureCommentUrl,
          ghsaHtmlUrl: findingDisclosure.ghsaHtmlUrl,
          closedAt: findingStatus.closureDetectedAt,
        })
        .from(findingStatus)
        .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
        .leftJoin(findingDisclosure, eq(findingDisclosure.findingId, findingStatus.findingId))
        .where(baseConditions)
    : db
        .select({
          findingId: findingStatus.findingId,
          severity: findingStatus.severity,
          label: findingStatus.label,
          category: findingStatus.category,
          title: findingStatus.title,
          repoHash: reviews.repoHash,
          prNumber: reviews.prNumber,
          closureSha: findingStatus.closureSha,
          closureCommentUrl: findingStatus.closureCommentUrl,
          ghsaHtmlUrl: sql<string | null>`NULL`.as("ghsaHtmlUrl"),
          closedAt: findingStatus.closureDetectedAt,
        })
        .from(findingStatus)
        .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
        .where(baseConditions));
  // JS toSorted below severity-DESC + closedAt-DESC; the SQL ORDER BY
  // would be redundant, so we sort entirely in JS for clarity.
  const ranked = rows.toSorted((a, b) => {
    const sevDelta =
      (DIGEST_SEVERITY_RANK[a.severity.toLowerCase()] ?? -1) -
      (DIGEST_SEVERITY_RANK[b.severity.toLowerCase()] ?? -1);
    if (sevDelta !== 0) return -sevDelta;
    const at = a.closedAt?.getTime() ?? 0;
    const bt = b.closedAt?.getTime() ?? 0;
    return bt - at;
  });
  return ranked.slice(0, limit);
}

const DIGEST_SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  med: 2,
  medium: 2,
  high: 3,
  critical: 4,
};

// Mission Phase-2 P2-E — single-receipt detail page. Returns the full
// receipt context for one finding: same column projection as
// loadPublicReceiptsPage plus the JSONB that carries the per-provider
// reasoning + the agreement decision shape. The page consumes both. Same
// public_receipt = true gate as the list query — no public receipt = 404.
export type PublicReceiptDetailRow = PublicReceiptRow & {
  reviewId: string;
  findingIndex: number;
  status: string;
  prCommentUrl: string | null;
  reviewCreatedAt: Date;
  timingMs: number;
  costEstimatedUsd: string;
  providerModelIds: unknown;
  providerResponses: unknown;
  agreementDecision: unknown;
  // Retraction surface (migration 0030). Non-null retractedAt flips the
  // /receipts/{id} page into a retraction notice (no claim text, noindex),
  // mirroring the /anatomy page. Loaded (not filtered) so the URL stays live.
  retractedAt: Date | null;
  retractionReason: string | null;
};

// M12: cache() deduplicates identical calls within a single render pass
// (generateMetadata + page + OG image all call the same loader with the same
// argument — without cache() each issues a separate DB round-trip).
export const loadPublicReceiptDetail = cache(
  async (findingId: string): Promise<PublicReceiptDetailRow | null> => {
    const disclosureGateEnabled = isDisclosureGateEnabled();
    const visibilityCondition = and(
      disclosureGateEnabled ? derivedPublicReceiptCondition : eq(reviews.publicReceipt, true),
      nonCyberTierRepoCondition(),
    );
    const baseSelectColumns = {
      findingId: findingStatus.findingId,
      findingIndex: findingStatus.findingIndex,
      status: findingStatus.status,
      severity: findingStatus.severity,
      label: findingStatus.label,
      category: findingStatus.category,
      title: findingStatus.title,
      closureSha: findingStatus.closureSha,
      closureCommentUrl: findingStatus.closureCommentUrl,
      closedAt: findingStatus.closureDetectedAt,
      retractedAt: findingStatus.retractedAt,
      retractionReason: findingStatus.retractionReason,
      reviewId: reviews.reviewId,
      repoHash: reviews.repoHash,
      prNumber: reviews.prNumber,
      prCommentUrl: reviews.prCommentUrl,
      reviewCreatedAt: reviews.createdAt,
      timingMs: reviews.timingMs,
      costEstimatedUsd: reviews.costEstimatedUsd,
      providerModelIds: reviews.providerModelIds,
      providerResponses: reviews.providerResponses,
      agreementDecision: reviews.agreementDecision,
    };
    const disclosureSelectColumns = {
      ...baseSelectColumns,
      ghsaHtmlUrl: findingDisclosure.ghsaHtmlUrl,
    };
    const legacySelectColumns = {
      ...baseSelectColumns,
      ghsaHtmlUrl: sql<string | null>`NULL`.as("ghsaHtmlUrl"),
    };
    const rows = await (disclosureGateEnabled
      ? db
          .select(disclosureSelectColumns)
          .from(findingStatus)
          .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
          .leftJoin(findingDisclosure, eq(findingDisclosure.findingId, findingStatus.findingId))
          .where(and(eq(findingStatus.findingId, findingId), visibilityCondition))
          .limit(1)
      : db
          .select(legacySelectColumns)
          .from(findingStatus)
          .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
          .where(and(eq(findingStatus.findingId, findingId), visibilityCondition))
          .limit(1));

    return rows[0] ?? null;
  },
);

export type PublicReviewReceiptRow = {
  reviewId: string;
  repoHash: string;
  owner: string | null;
  repo: string | null;
  prNumber: number;
  commitSha: string;
  createdAt: Date;
  processingStatus: string;
  processingError: string | null;
  timingMs: number;
  costEstimatedUsd: string;
  agreementDecision: unknown;
  jobId: string | null;
  paymentRail: string | null;
  jobStatus: string | null;
  failureMode: string | null;
  failureMessage: string | null;
  x402PayTo: string | null;
  callerWallet: string | null;
  settlementStatus: string | null;
  findings: Array<{
    findingId: string;
    findingIndex: number;
    severity: string;
    category: string;
    title: string;
  }>;
};

export async function loadPublicReviewReceipt(
  reviewId: string,
): Promise<PublicReviewReceiptRow | null> {
  // Cyber-tier repos hide the review entirely from the public review
  // receipt endpoint. Flag-gated SQL fragment — empty when OFF.
  const cyberTierExclusion = sql`AND NOT EXISTS (
    SELECT 1 FROM repo_tier
    WHERE owner_lc = lower(r.owner) AND repo_lc = lower(r.repo) AND tier = 'cyber'
  )`;
  const cyberExclude = isCyberTierEnabled() ? cyberTierExclusion : sql``;
  const result = await db.execute(
    isDisclosureGateEnabled()
      ? sql`
          SELECT
            r.review_id AS "reviewId",
            r.repo_hash AS "repoHash",
            r.owner,
            r.repo,
            r.pr_number AS "prNumber",
            r.commit_sha AS "commitSha",
            r.created_at AS "createdAt",
            r.processing_status AS "processingStatus",
            r.processing_error AS "processingError",
            r.timing_ms AS "timingMs",
            r.cost_estimated_usd::text AS "costEstimatedUsd",
            r.agreement_decision AS "agreementDecision",
            j.job_id AS "jobId",
            j.payment_rail AS "paymentRail",
            j.status AS "jobStatus",
            j.failure_mode AS "failureMode",
            j.failure_message AS "failureMessage",
            j.x402_pay_to AS "x402PayTo",
            j.caller_wallet AS "callerWallet",
            j.x402_settlement_status AS "settlementStatus",
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'findingId', fs.finding_id,
                  'findingIndex', fs.finding_index,
                  'severity', fs.severity,
                  'category', fs.category,
                  'title', fs.title
                )
                ORDER BY fs.finding_index
              ) FILTER (
                WHERE fs.finding_id IS NOT NULL
                  AND (
                    (
	                      fd.state = 'published'
	                      AND (
	                        (
	                          fd.ghsa_id IS NULL
	                          AND fs.closure_comment_url IS NOT NULL
	                        )
	                        OR (
	                          fd.ghsa_id IS NOT NULL
	                          AND fd.ghsa_published_at IS NOT NULL
	                          AND fd.ghsa_html_url IS NOT NULL
	                        )
	                      )
                    )
                    OR (fd.state = 'none' AND r.public_receipt = true)
                  )
              ),
              '[]'::jsonb
            ) AS "findings"
          FROM reviews r
          LEFT JOIN finding_status fs ON fs.review_id = r.review_id
          LEFT JOIN finding_disclosure fd ON fd.finding_id = fs.finding_id
          LEFT JOIN review_jobs j ON (
            j.x402_review_id = r.review_id
            OR (
              j.x402_review_id IS NULL
              AND lower(j.repo_owner) = lower(COALESCE(r.owner, ''))
              AND lower(j.repo_name) = lower(COALESCE(r.repo, ''))
              AND j.pr_number = r.pr_number
              AND lower(j.sha) = lower(r.commit_sha)
            )
          )
          WHERE r.review_id = ${reviewId}
            AND r.public_receipt = true
            ${cyberExclude}
            AND NOT EXISTS (
              SELECT 1
              FROM finding_status review_fs
              LEFT JOIN finding_disclosure review_fd ON review_fd.finding_id = review_fs.finding_id
              WHERE review_fs.review_id = r.review_id
                AND (
                  review_fd.finding_id IS NULL
                  OR NOT (
                    (
	                      review_fd.state = 'published'
	                      AND (
	                        (
	                          review_fd.ghsa_id IS NULL
	                          AND review_fs.closure_comment_url IS NOT NULL
	                        )
	                        OR (
	                          review_fd.ghsa_id IS NOT NULL
	                          AND review_fd.ghsa_published_at IS NOT NULL
	                          AND review_fd.ghsa_html_url IS NOT NULL
	                        )
	                      )
                    )
                    OR (review_fd.state = 'none' AND r.public_receipt = true)
                  )
                )
            )
          GROUP BY r.review_id, j.job_id
          ORDER BY j.created_at DESC NULLS LAST
          LIMIT 1
        `
      : sql`
          SELECT
            r.review_id AS "reviewId",
            r.repo_hash AS "repoHash",
            r.owner,
            r.repo,
            r.pr_number AS "prNumber",
            r.commit_sha AS "commitSha",
            r.created_at AS "createdAt",
            r.processing_status AS "processingStatus",
            r.processing_error AS "processingError",
            r.timing_ms AS "timingMs",
            r.cost_estimated_usd::text AS "costEstimatedUsd",
            r.agreement_decision AS "agreementDecision",
            j.job_id AS "jobId",
            j.payment_rail AS "paymentRail",
            j.status AS "jobStatus",
            j.failure_mode AS "failureMode",
            j.failure_message AS "failureMessage",
            j.x402_pay_to AS "x402PayTo",
            j.caller_wallet AS "callerWallet",
            j.x402_settlement_status AS "settlementStatus",
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'findingId', fs.finding_id,
                  'findingIndex', fs.finding_index,
                  'severity', fs.severity,
                  'category', fs.category,
                  'title', fs.title
                )
                ORDER BY fs.finding_index
              ) FILTER (WHERE fs.finding_id IS NOT NULL),
              '[]'::jsonb
            ) AS "findings"
          FROM reviews r
          LEFT JOIN finding_status fs ON fs.review_id = r.review_id
          LEFT JOIN review_jobs j ON (
            j.x402_review_id = r.review_id
            OR (
              j.x402_review_id IS NULL
              AND lower(j.repo_owner) = lower(COALESCE(r.owner, ''))
              AND lower(j.repo_name) = lower(COALESCE(r.repo, ''))
              AND j.pr_number = r.pr_number
              AND lower(j.sha) = lower(r.commit_sha)
            )
          )
          WHERE r.review_id = ${reviewId}
            AND r.public_receipt = true
            ${cyberExclude}
          GROUP BY r.review_id, j.job_id
          ORDER BY j.created_at DESC NULLS LAST
          LIMIT 1
        `,
  );
  const rows = Array.isArray(result)
    ? (result as PublicReviewReceiptRow[])
    : ((result as unknown as { rows?: PublicReviewReceiptRow[] }).rows ?? []);
  return rows[0] ?? null;
}

// Phase-2 P2-G — /activity page. Aggregate counters are repo-blind
// (privacy-safe by construction — just integers across all installs),
// recent events stream respects the public_receipt opt-in gate (only
// rows from opted-in reviews surface).
export type FleetActivityPage = {
  lastSweepAt: Date | null;
  lastReceiptAt: Date | null;
  // max(onboarding_events.created_at) for public rows. Drives the
  // "last seen" timestamp on the Onboarder row in the agent roster.
  lastOnboarderAt: Date | null;
  // max(reviews.created_at). Drives "last seen" for per-review agents so
  // they reflect when a review actually ran, not when a finding was closed.
  lastReviewAt: Date | null;
  windows: {
    last24h: ActivityWindow;
    last7d: ActivityWindow;
    allTime: ActivityWindow;
  };
  events: FleetActivityEvent[];
};

export type OnboarderEventType =
  | "install_welcome"
  | "first_review_summary"
  | "public_receipts_enabled"
  | "public_receipts_disabled"
  | "check_in_7d"
  // Partner-replied: someone (not antfleet[bot]) commented on a welcome
  // issue. Captured for NPS-style signal — read by weekly-digest and
  // by analysis scripts. Rows are private (public=false always); the
  // /activity event stream filters them out by kind, not by gate.
  | "partner_reply"
  // Paywall lifecycle. Distinct from the legacy install_welcome series
  // because these are emitted by the agent paywall flow (POST /v1/...)
  // and the webhook drawdown gate, not by the GitHub-install onboarder.
  //   wallet_bound        — EIP-191 signature verified on bind
  //   channel_funded      — first USDC deposit credited; status → active
  //   channel_low_balance — drawdown attempt rejected for insufficient funds
  //   drawdown_recorded   — per-review debit succeeded
  | "wallet_bound"
  | "channel_funded"
  | "channel_low_balance"
  | "drawdown_recorded"
  // Patch Agent v1.5 lifecycle. Distinct from the finding event set;
  // these track the suggested-patch lane specifically.
  //   patch_proposed  — review-worker shipped a suggestion block on the PR
  //   patch_accepted  — sweeper detected the suggestion in HEAD on the
  //                     default branch
  // Both rows are public when the underlying review has publicReceipt=true
  // (per spec invariant 8 — no separate opt-in flag added in v1).
  | "patch_proposed"
  | "patch_accepted";

export type ActivityWindow = {
  reviewsRun: number;
  findingsAgreed: number;
  receiptsClosed: number;
  reactionsObserved: number;
};

export type FleetActivityEvent =
  | {
      kind: "review_completed";
      ts: Date;
      repoHash: string;
      prNumber: number;
      // owner/repo only populated for publicReceipt rows (which are the
      // only ones surfaced anyway). Null for legacy rows pre Mission 3.
      owner: string | null;
      repo: string | null;
    }
  | {
      kind: "finding_agreed";
      ts: Date;
      findingId: string;
      severity: string;
      category: string;
      title: string;
      repoHash: string;
      owner: string | null;
      repo: string | null;
    }
  | {
      kind: "finding_closed";
      ts: Date;
      findingId: string;
      severity: string;
      category: string;
      title: string;
      closureSha: string | null;
      repoHash: string;
      owner: string | null;
      repo: string | null;
    }
  | {
      // Single discriminator for every Onboarder action; eventType
      // carries the action specifics. New event_type strings can be
      // added to OnboarderEventType without touching the union.
      kind: "onboarder_action";
      ts: Date;
      eventType: OnboarderEventType;
      repoHash: string;
      commentUrl: string | null;
    };

const EVENT_STREAM_LIMIT = 20;

export async function loadFleetActivity(): Promise<FleetActivityPage> {
  const now = new Date();
  const ms24h = 24 * 60 * 60 * 1000;
  const ms7d = 7 * ms24h;
  const since24h = new Date(now.getTime() - ms24h);
  const since7d = new Date(now.getTime() - ms7d);
  const disclosureGateEnabled = isDisclosureGateEnabled();
  const cyberTierGate = nonCyberTierRepoCondition();
  const reviewPublicGate = and(
    disclosureGateEnabled ? reviewDerivedPublicReceiptCondition : eq(reviews.publicReceipt, true),
    cyberTierGate,
  );
  const findingPublicGate = and(
    disclosureGateEnabled ? derivedPublicReceiptCondition : eq(reviews.publicReceipt, true),
    cyberTierGate,
  );

  const [
    lastSweep,
    lastReceipt,
    lastOnboarder,
    lastReview,
    win24h,
    win7d,
    winAll,
    eventReviews,
    eventAgreed,
    eventClosed,
    eventOnboarder,
  ] = await Promise.all([
    db.select({ value: max(findingStatus.lastPolledAt) }).from(findingStatus),
    disclosureGateEnabled
      ? db
          .select({ value: max(findingStatus.closureDetectedAt) })
          .from(findingStatus)
          .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
          .leftJoin(findingDisclosure, eq(findingDisclosure.findingId, findingStatus.findingId))
          .where(and(eq(findingStatus.status, "closed"), findingPublicGate))
      : db
          .select({ value: max(findingStatus.closureDetectedAt) })
          .from(findingStatus)
          .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
          .where(and(eq(findingStatus.status, "closed"), findingPublicGate)),
    db
      .select({ value: max(onboardingEvents.createdAt) })
      .from(onboardingEvents)
      .where(eq(onboardingEvents.public, true)),
    db
      .select({ value: max(reviews.createdAt) })
      .from(reviews)
      .where(reviewPublicGate),
    activityWindow(since24h),
    activityWindow(since7d),
    loadAllTimeActivityWindow(),
    // M10 fix: removed the LEFT JOIN on finding_status — it multiplied rows
    // by finding count, so LIMIT 20 could return only 1 review with 20
    // findings. Zero-finding reviews still surface because the join was
    // LEFT (they just added no value here). The dedup loop below is kept
    // as a safety net but will now always be a no-op.
    db
      .select({
        ts: reviews.createdAt,
        repoHash: reviews.repoHash,
        prNumber: reviews.prNumber,
        owner: reviews.owner,
        repo: reviews.repo,
      })
      .from(reviews)
      .where(reviewPublicGate)
      .orderBy(desc(reviews.createdAt))
      .limit(EVENT_STREAM_LIMIT),
    disclosureGateEnabled
      ? db
          .select({
            ts: findingStatus.createdAt,
            findingId: findingStatus.findingId,
            severity: findingStatus.severity,
            category: findingStatus.category,
            title: findingStatus.title,
            repoHash: reviews.repoHash,
            owner: reviews.owner,
            repo: reviews.repo,
          })
          .from(findingStatus)
          .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
          .leftJoin(findingDisclosure, eq(findingDisclosure.findingId, findingStatus.findingId))
          .where(findingPublicGate)
          .orderBy(desc(findingStatus.createdAt))
          .limit(EVENT_STREAM_LIMIT)
      : db
          .select({
            ts: findingStatus.createdAt,
            findingId: findingStatus.findingId,
            severity: findingStatus.severity,
            category: findingStatus.category,
            title: findingStatus.title,
            repoHash: reviews.repoHash,
            owner: reviews.owner,
            repo: reviews.repo,
          })
          .from(findingStatus)
          .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
          .where(findingPublicGate)
          .orderBy(desc(findingStatus.createdAt))
          .limit(EVENT_STREAM_LIMIT),
    disclosureGateEnabled
      ? db
          .select({
            ts: findingStatus.closureDetectedAt,
            findingId: findingStatus.findingId,
            severity: findingStatus.severity,
            category: findingStatus.category,
            title: findingStatus.title,
            closureSha: findingStatus.closureSha,
            repoHash: reviews.repoHash,
            owner: reviews.owner,
            repo: reviews.repo,
          })
          .from(findingStatus)
          .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
          .leftJoin(findingDisclosure, eq(findingDisclosure.findingId, findingStatus.findingId))
          .where(and(eq(findingStatus.status, "closed"), findingPublicGate))
          .orderBy(desc(findingStatus.closureDetectedAt))
          .limit(EVENT_STREAM_LIMIT)
      : db
          .select({
            ts: findingStatus.closureDetectedAt,
            findingId: findingStatus.findingId,
            severity: findingStatus.severity,
            category: findingStatus.category,
            title: findingStatus.title,
            closureSha: findingStatus.closureSha,
            repoHash: reviews.repoHash,
            owner: reviews.owner,
            repo: reviews.repo,
          })
          .from(findingStatus)
          .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
          .where(and(eq(findingStatus.status, "closed"), findingPublicGate))
          .orderBy(desc(findingStatus.closureDetectedAt))
          .limit(EVENT_STREAM_LIMIT),
    db
      .select({
        ts: onboardingEvents.createdAt,
        eventType: onboardingEvents.eventType,
        repoHash: onboardingEvents.repoHash,
        commentUrl: onboardingEvents.commentUrl,
      })
      .from(onboardingEvents)
      .where(eq(onboardingEvents.public, true))
      .orderBy(desc(onboardingEvents.createdAt))
      .limit(EVENT_STREAM_LIMIT),
  ]);

  // Merge the three sources into one chronologically-sorted event stream
  // (dedup not needed — different rows, different ids).
  const events: FleetActivityEvent[] = [];
  // Deduplicate reviews by (repoHash, prNumber) keeping the latest ts —
  // multiple finding_status rows per review otherwise produce duplicate
  // review_completed events.
  const seenReviews = new Set<string>();
  for (const r of eventReviews) {
    const key = `${r.repoHash}#${r.prNumber}`;
    if (seenReviews.has(key)) continue;
    seenReviews.add(key);
    events.push({
      kind: "review_completed",
      ts: r.ts,
      repoHash: r.repoHash,
      prNumber: r.prNumber,
      owner: r.owner,
      repo: r.repo,
    });
  }
  for (const f of eventAgreed) {
    events.push({
      kind: "finding_agreed",
      ts: f.ts,
      findingId: f.findingId,
      severity: f.severity,
      category: f.category,
      title: f.title,
      repoHash: f.repoHash,
      owner: f.owner,
      repo: f.repo,
    });
  }
  for (const f of eventClosed) {
    if (f.ts === null) continue;
    events.push({
      kind: "finding_closed",
      ts: f.ts,
      findingId: f.findingId,
      severity: f.severity,
      category: f.category,
      title: f.title,
      closureSha: f.closureSha,
      repoHash: f.repoHash,
      owner: f.owner,
      repo: f.repo,
    });
  }
  for (const e of eventOnboarder) {
    // Defensive: skip rows whose event_type doesn't match the typed
    // vocabulary. New types must be added to OnboarderEventType before
    // they'll render — keeps the union and the data in lock-step.
    if (!isOnboarderEventType(e.eventType)) continue;
    // Per-customer raw content (partner replies) never surfaces here,
    // even when public=true. The privacy boundary lives in the kind
    // filter, not just in the public column.
    if (!ACTIVITY_SURFACED_ONBOARDER_KINDS.has(e.eventType)) continue;
    events.push({
      kind: "onboarder_action",
      ts: e.ts,
      eventType: e.eventType,
      repoHash: e.repoHash,
      commentUrl: e.commentUrl,
    });
  }
  events.sort((a, b) => b.ts.getTime() - a.ts.getTime());

  const lastSweepRaw = lastSweep[0]?.value ?? null;
  const lastReceiptRaw = lastReceipt[0]?.value ?? null;
  const lastOnboarderRaw = lastOnboarder[0]?.value ?? null;
  const lastReviewRaw = lastReview[0]?.value ?? null;

  return {
    lastSweepAt: coerceDate(lastSweepRaw),
    lastReceiptAt: coerceDate(lastReceiptRaw),
    lastOnboarderAt: coerceDate(lastOnboarderRaw),
    lastReviewAt: coerceDate(lastReviewRaw),
    windows: {
      last24h: win24h,
      last7d: win7d,
      allTime: winAll,
    },
    events: events.slice(0, EVENT_STREAM_LIMIT),
  };
}

const ONBOARDER_EVENT_TYPES: ReadonlySet<OnboarderEventType> = new Set([
  "install_welcome",
  "first_review_summary",
  "public_receipts_enabled",
  "public_receipts_disabled",
  "check_in_7d",
  "partner_reply",
  "wallet_bound",
  "channel_funded",
  "channel_low_balance",
  "drawdown_recorded",
]);

// /activity hides partner replies even when public=true. They're per-
// customer raw content (free-text issue comments) and never belong on
// the public surface; the strategy doc §10 boundary requires it.
const ACTIVITY_SURFACED_ONBOARDER_KINDS: ReadonlySet<OnboarderEventType> = new Set([
  "install_welcome",
  "first_review_summary",
  "public_receipts_enabled",
  "public_receipts_disabled",
  "check_in_7d",
]);

function isOnboarderEventType(value: string): value is OnboarderEventType {
  return ONBOARDER_EVENT_TYPES.has(value as OnboarderEventType);
}

// ─── Onboarder persistence helpers ──────────────────────────────────────────
// One row per agent action. The agent's tool output is stored verbatim in
// tool_output so we can replay every decision and rebuild prompts later.

export type RecordOnboardingEventInput = Omit<NewOnboardingEvent, "id" | "createdAt">;

export async function recordOnboardingEvent(input: RecordOnboardingEventInput): Promise<string> {
  const result = await db
    .insert(onboardingEvents)
    .values(input)
    .returning({ id: onboardingEvents.id });
  const row = result[0];
  if (row === undefined) {
    throw new Error("recordOnboardingEvent: insert returned no row");
  }
  return row.id;
}

// Idempotency check. Onboarder fires off `installation.created` AND
// `installation_repositories.added`; both can arrive for the same repo
// when an install is broadened. Without this gate we'd post duplicate
// welcome issues.
export async function hasOnboardingEventForInstall(
  installationId: number,
  owner: string,
  repo: string,
  eventType: OnboarderEventType,
): Promise<boolean> {
  const rows = await db
    .select({ id: onboardingEvents.id })
    .from(onboardingEvents)
    .where(
      and(
        eq(onboardingEvents.installationId, installationId),
        eq(onboardingEvents.owner, owner),
        eq(onboardingEvents.repo, repo),
        eq(onboardingEvents.eventType, eventType),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// Fetch the most recent onboarding event of a given type for an install,
// or null. Used by check-in to find the welcome issue number to post on.
export async function getOnboardingEventForInstall(
  installationId: number,
  owner: string,
  repo: string,
  eventType: OnboarderEventType,
): Promise<OnboardingEvent | null> {
  const rows = await db
    .select()
    .from(onboardingEvents)
    .where(
      and(
        eq(onboardingEvents.installationId, installationId),
        eq(onboardingEvents.owner, owner),
        eq(onboardingEvents.repo, repo),
        eq(onboardingEvents.eventType, eventType),
      ),
    )
    .orderBy(desc(onboardingEvents.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

// Used by the webhook's issue_comment.created handler — looks up whether
// a given (install, repo, issue_number) is one of our welcome issues.
// Welcome rows persist the GitHub issue number in `comment_id` (a slight
// schema-shape overload, but issues and comments share the numeric id
// space well enough for our needs).
export async function isWelcomeIssue(
  installationId: number,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: onboardingEvents.id })
    .from(onboardingEvents)
    .where(
      and(
        eq(onboardingEvents.installationId, installationId),
        eq(onboardingEvents.owner, owner),
        eq(onboardingEvents.repo, repo),
        eq(onboardingEvents.eventType, "install_welcome"),
        eq(onboardingEvents.commentId, issueNumber),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// Used by Onboarder to detect "first review" — Reviewer has already
// recorded its row by the time first_review_summary fires, so a count
// of 1 means "this review is the first".
export async function countReviewsForInstall(installationId: number): Promise<number> {
  const rows = await db
    .select({ value: count(reviews.reviewId) })
    .from(reviews)
    .where(eq(reviews.installationId, installationId));
  return rows[0]?.value ?? 0;
}

// 7-day check-in candidate query. Returns installations whose
// install_welcome row was created between (now - 8d) and (now - 7d) and
// that don't yet have a check_in_7d row. The 1-day window keeps the
// cron idempotent across daily ticks (a missed day still catches the
// install once it slides into range).
export type CheckInCandidate = {
  installationId: number;
  owner: string;
  repo: string;
  welcomeCreatedAt: Date;
};

export async function loadCheckInCandidates(now: Date): Promise<CheckInCandidate[]> {
  const ms24h = 24 * 60 * 60 * 1000;
  const upper = new Date(now.getTime() - 7 * ms24h);
  const lower = new Date(now.getTime() - 8 * ms24h);
  const welcomes = await db
    .select({
      installationId: onboardingEvents.installationId,
      owner: onboardingEvents.owner,
      repo: onboardingEvents.repo,
      welcomeCreatedAt: onboardingEvents.createdAt,
    })
    .from(onboardingEvents)
    .where(
      and(
        eq(onboardingEvents.eventType, "install_welcome"),
        gte(onboardingEvents.createdAt, lower),
        lt(onboardingEvents.createdAt, upper),
      ),
    );
  if (welcomes.length === 0) return [];

  // Filter out installs that already have a check-in row. Done as a
  // second pass rather than a join — keeps the SQL simple at the cost
  // of one extra round-trip per candidate. Acceptable at expected
  // partner volume (single digits in Phase 2).
  const out: CheckInCandidate[] = [];
  for (const w of welcomes) {
    const already = await hasOnboardingEventForInstall(
      w.installationId,
      w.owner,
      w.repo,
      "check_in_7d",
    );
    if (!already) out.push(w);
  }
  return out;
}

// Activity stats over a (install, repo) for the check-in prompt.
export type InstallActivitySnapshot = {
  reviewCount: number;
  findingsAgreed: number;
  findingsClosed: number;
  reactionsObserved: number;
};

export async function snapshotInstallActivity(
  installationId: number,
): Promise<InstallActivitySnapshot> {
  const [revCount, agreed, closed, reacted] = await Promise.all([
    db
      .select({ value: count(reviews.reviewId) })
      .from(reviews)
      .where(eq(reviews.installationId, installationId)),
    db
      .select({ value: count(findingStatus.id) })
      .from(findingStatus)
      .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
      .where(eq(reviews.installationId, installationId)),
    db
      .select({ value: count(findingStatus.id) })
      .from(findingStatus)
      .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
      .where(and(eq(reviews.installationId, installationId), eq(findingStatus.status, "closed"))),
    db
      .select({ value: count(maintainerReactions.reactionId) })
      .from(maintainerReactions)
      .innerJoin(reviews, eq(maintainerReactions.reviewId, reviews.reviewId))
      .where(eq(reviews.installationId, installationId)),
  ]);
  return {
    reviewCount: revCount[0]?.value ?? 0,
    findingsAgreed: agreed[0]?.value ?? 0,
    findingsClosed: closed[0]?.value ?? 0,
    reactionsObserved: reacted[0]?.value ?? 0,
  };
}

// Pure clamping for the activityWindow() time bounds. Three rules:
//   1. until in the future ⇒ treat as null ("up to now") so a digest URL
//      rendered today renders the same numbers next week.
//   2. until < since ⇒ short-circuit to a zero-counter result (caller
//      avoids issuing impossible-range queries against the DB).
//   3. since/until null are passed through; the SQL builder turns them
//      into open-ended bounds.
export function normalizeActivityWindow(
  since: Date | null,
  until: Date | null,
  now: Date,
): { since: Date | null; until: Date | null; zero: boolean } {
  const clampedUntil = until === null ? null : until.getTime() > now.getTime() ? null : until;
  if (since !== null && clampedUntil !== null && clampedUntil.getTime() < since.getTime()) {
    return { since: null, until: null, zero: true };
  }
  return { since, until: clampedUntil, zero: false };
}

// Counters for the /activity dashboard and any future digest page.
//
// Every counter is gated by reviews.publicReceipt = true so the headline
// numbers always equal what the public /receipts page can substantiate.
// Before this gate the page showed "receipts closed all-time = 41" while
// /receipts itself listed only 32; the delta was non-opted-in dogfood
// rows. Public-facing copy must use this helper or the JSON it backs.
//
// untilDate defaults to null = "up to now". Pass an explicit upper bound
// for reproducible digest permalinks (the weekly /digest page renders the
// same numbers no matter when the URL is re-opened).
export async function activityWindow(
  sinceDate: Date | null,
  untilDate: Date | null = null,
): Promise<ActivityWindow> {
  const { since, until, zero } = normalizeActivityWindow(sinceDate, untilDate, new Date());
  if (zero) {
    return {
      reviewsRun: 0,
      findingsAgreed: 0,
      receiptsClosed: 0,
      reactionsObserved: 0,
    };
  }

  // Build inclusive lower / exclusive upper bounds on each timestamp so
  // back-to-back weekly digests don't double-count the boundary moment.
  const reviewsRange = and(
    since === null ? undefined : gte(reviews.createdAt, since),
    until === null ? undefined : lt(reviews.createdAt, until),
  );
  const findingsCreatedRange = and(
    since === null ? undefined : gte(findingStatus.createdAt, since),
    until === null ? undefined : lt(findingStatus.createdAt, until),
  );
  const findingsClosedRange = and(
    eq(findingStatus.status, "closed"),
    since === null ? undefined : gte(findingStatus.closureDetectedAt, since),
    until === null ? undefined : lt(findingStatus.closureDetectedAt, until),
  );
  const reactionsRange = and(
    since === null ? undefined : gte(maintainerReactions.polledAt, since),
    until === null ? undefined : lt(maintainerReactions.polledAt, until),
  );

  const disclosureGateEnabled = isDisclosureGateEnabled();
  const cyberTierGate = nonCyberTierRepoCondition();
  const publicGate = and(
    disclosureGateEnabled ? reviewDerivedPublicReceiptCondition : eq(reviews.publicReceipt, true),
    cyberTierGate,
  );
  const findingPublicGate = and(
    disclosureGateEnabled ? derivedPublicReceiptCondition : eq(reviews.publicReceipt, true),
    cyberTierGate,
  );

  const reviewsCountQuery = db
    .select({ value: count() })
    .from(reviews)
    .where(and(publicGate, reviewsRange));

  const agreedCountQuery = disclosureGateEnabled
    ? db
        .select({ value: count() })
        .from(findingStatus)
        .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
        .leftJoin(findingDisclosure, eq(findingDisclosure.findingId, findingStatus.findingId))
        .where(and(findingPublicGate, findingsCreatedRange))
    : db
        .select({ value: count() })
        .from(findingStatus)
        .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
        .where(and(findingPublicGate, findingsCreatedRange));

  const closedCountQuery = disclosureGateEnabled
    ? db
        .select({ value: count() })
        .from(findingStatus)
        .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
        .leftJoin(findingDisclosure, eq(findingDisclosure.findingId, findingStatus.findingId))
        .where(and(findingPublicGate, findingsClosedRange))
    : db
        .select({ value: count() })
        .from(findingStatus)
        .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
        .where(and(findingPublicGate, findingsClosedRange));

  const reactionsCountQuery = db
    .select({ value: count() })
    .from(maintainerReactions)
    .innerJoin(reviews, eq(maintainerReactions.reviewId, reviews.reviewId))
    .where(and(publicGate, reactionsRange));

  const [r, a, c, x] = await Promise.all([
    reviewsCountQuery,
    agreedCountQuery,
    closedCountQuery,
    reactionsCountQuery,
  ]);

  return {
    reviewsRun: r[0]?.value ?? 0,
    findingsAgreed: a[0]?.value ?? 0,
    receiptsClosed: c[0]?.value ?? 0,
    reactionsObserved: x[0]?.value ?? 0,
  };
}

// Cached wrapper around activityWindow(null) — the per-request StatsStrip
// surface reads all-time reviewsRun + findingsAgreed, and /activity reads
// the same numbers for its allTime slot. cache() lets both call sites share
// one query.
export const loadAllTimeActivityWindow = cache(
  async (): Promise<ActivityWindow> => activityWindow(null),
);

function coerceDate(raw: unknown): Date | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return raw;
  if (typeof raw === "string") return new Date(raw);
  return null;
}

// Self-serve opt-in toggle. The Onboarder's first-review summary comment
// embeds a one-click link; the /api/opt-in route invokes this helper.
// Returns counts so the caller can distinguish three states:
//   - alreadyMatching > 0, flipped == 0: no-op (idempotent re-click)
//   - flipped > 0:                       state changed, emit audit event
//   - alreadyMatching == 0, flipped == 0: no reviews for this (install,
//     owner, repo) yet — render a friendly "no reviews here yet" page.
export async function flipPublicReceiptForRepo(args: {
  installationId: number;
  owner: string;
  repo: string;
  target: boolean;
}): Promise<{ alreadyMatching: number; flipped: number; totalMatching: number }> {
  const scope = and(
    eq(reviews.installationId, args.installationId),
    eq(reviews.owner, args.owner),
    eq(reviews.repo, args.repo),
  );
  const totals = await db
    .select({
      total: sql<number>`count(*)::int`.as("total"),
      atTarget:
        sql<number>`count(*) filter (where ${reviews.publicReceipt} = ${args.target})::int`.as(
          "at_target",
        ),
    })
    .from(reviews)
    .where(scope);
  const t = totals[0] ?? { total: 0, atTarget: 0 };
  const totalMatching = t.total;
  const alreadyMatching = t.atTarget;
  const toFlip = totalMatching - alreadyMatching;
  if (toFlip <= 0) {
    return { alreadyMatching, flipped: 0, totalMatching };
  }
  const updated = await db
    .update(reviews)
    .set({ publicReceipt: args.target })
    .where(and(scope, eq(reviews.publicReceipt, !args.target)))
    .returning({ reviewId: reviews.reviewId });
  return { alreadyMatching, flipped: updated.length, totalMatching };
}

export async function recordMaintainerReactions(rows: NewMaintainerReaction[]): Promise<number> {
  if (rows.length === 0) return 0;

  // Dedup: dismiss:reply rows are idempotent per (reviewId, findingId,
  // reactorLogin) — a maintainer's second dismiss comment on the same finding
  // (with a different created_at timestamp) would bypass the UNIQUE constraint
  // on (reviewId, findingId, reactionAt, actionTaken). Filter out any
  // dismiss:reply row whose (reviewId, findingId, reactorLogin) triple already
  // has a recorded dismiss, so the first dismiss is the durable signal.
  const dismissRows = rows.filter(
    (r) => r.actionTaken === "dismiss:reply" && r.reactorLogin != null,
  );
  let dedupedRows = rows;
  if (dismissRows.length > 0) {
    const existing = await db
      .select({
        reviewId: maintainerReactions.reviewId,
        findingId: maintainerReactions.findingId,
        reactorLogin: maintainerReactions.reactorLogin,
      })
      .from(maintainerReactions)
      .where(
        and(
          eq(maintainerReactions.actionTaken, "dismiss:reply"),
          or(
            ...dismissRows.map((r) =>
              and(
                eq(maintainerReactions.reviewId, r.reviewId),
                eq(maintainerReactions.findingId, r.findingId),
                eq(maintainerReactions.reactorLogin, r.reactorLogin!),
              ),
            ),
          ),
        ),
      );
    const alreadyDismissed = new Set(
      existing.map((e) => `${e.reviewId}:${e.findingId}:${e.reactorLogin}`),
    );
    dedupedRows = rows.filter((r) => {
      if (r.actionTaken !== "dismiss:reply" || r.reactorLogin == null) return true;
      return !alreadyDismissed.has(`${r.reviewId}:${r.findingId}:${r.reactorLogin}`);
    });
  }

  if (dedupedRows.length === 0) return 0;
  const inserted = await db
    .insert(maintainerReactions)
    .values(dedupedRows)
    .onConflictDoNothing({
      target: [
        maintainerReactions.reviewId,
        maintainerReactions.findingId,
        maintainerReactions.reactionAt,
        maintainerReactions.actionTaken,
      ],
    })
    .returning({ reactionId: maintainerReactions.reactionId });
  return inserted.length;
}

// ─── Step 0.5 — precision feedback ─────────────────────────────────────────
//
// Verifies that a findingId belongs to a review in the given installation and
// repo before trusting a maintainer dismiss command. Guards against forged ids
// in the @antfleet dismiss webhook path (route.ts). Returns null when the
// findingId is unknown or belongs to a different install — the caller discards
// silently in both cases.
export async function lookupFindingForInstall(
  findingId: string,
  installationId: number,
  repo: string,
): Promise<{ reviewId: string } | null> {
  const rows = await db
    .select({ reviewId: findingStatus.reviewId })
    .from(findingStatus)
    .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
    .where(
      and(
        eq(findingStatus.findingId, findingId),
        eq(reviews.installationId, installationId),
        eq(reviews.repo, repo),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// Maintainer-dismiss auto-retraction (Step 0.5, item 6).
//
// Sets retractedAt + retractionReason on the finding when a verified
// maintainer dismisses it via @antfleet dismiss. Idempotent — the underlying
// WHERE retractedAt IS NULL means a second call is a safe no-op. Returns true
// when the row was retracted, false when it was already retracted or the
// findingId doesn't exist. retractionEmail is always null here: dismiss-by-
// reply doesn't carry an email and the requestor is already stored as
// reactorLogin in maintainer_reactions.
export async function retractFindingByDismiss(
  findingId: string,
  reason: string | null,
): Promise<boolean> {
  return retractFinding(findingId, reason ?? "maintainer-dismissed via PR reply", null);
}

// ─── Step 0.5 — precision metric (item 7) ──────────────────────────────────
//
// Per-tier dismiss rate for the precision baseline. Joined to reviews on the
// same publicReceipt gate as activityWindow so the numbers are comparable to
// existing activity counters. Tiers: low | medium | high | critical.
//
// postedCount: finding_status rows created in window (joined to public reviews).
// dismissedCount: DISTINCT finding_ids from THOSE SAME posted-in-window findings
//   that have ≥1 dismiss:reply by an authorised maintainer at any time (reactionAt
//   unbounded). Dismissed is structurally a SUBSET of posted so dismissRate ≤ 1.0.
//   DISMISS_AUTHORISED_ASSOCIATIONS is imported from precision-feedback-env.ts to
//   share the definition with the webhook ingest path.
// dismissRate: dismissedCount / postedCount, 0.0 when postedCount is 0.
//
// The secondary thumbsDownCount is from channel C (reaction:thumbs_down, low-
// trust, un-attributable) and is reported as a single aggregate — never merged
// into the primary rate. Internal-only; never rendered on public surfaces.
const PRECISION_TIERS = ["low", "medium", "high", "critical"] as const;
type PrecisionTier = (typeof PRECISION_TIERS)[number];

export type PrecisionTierStats = {
  tier: PrecisionTier;
  postedCount: number;
  dismissedCount: number;
  dismissRate: number;
};

export type PrecisionWindow = {
  tiers: PrecisionTierStats[];
  /** Channel C secondary — thumbs:down aggregate (all tiers, not merged into rate). */
  thumbsDownCount: number;
};

export async function precisionWindow(
  sinceDate: Date | null,
  untilDate: Date | null = null,
): Promise<PrecisionWindow> {
  const { since, until, zero } = normalizeActivityWindow(sinceDate, untilDate, new Date());
  const empty: PrecisionWindow = {
    tiers: PRECISION_TIERS.map((tier) => ({
      tier,
      postedCount: 0,
      dismissedCount: 0,
      dismissRate: 0,
    })),
    thumbsDownCount: 0,
  };
  if (zero) return empty;

  const findingsCreatedRange = and(
    since === null ? undefined : gte(findingStatus.createdAt, since),
    until === null ? undefined : lt(findingStatus.createdAt, until),
  );
  const reactionsRange = and(
    since === null ? undefined : gte(maintainerReactions.reactionAt, since),
    until === null ? undefined : lt(maintainerReactions.reactionAt, until),
  );
  const publicGate = eq(reviews.publicReceipt, true);

  // Per-tier posted count.
  const postedRows = await db
    .select({
      severity: findingStatus.severity,
      n: count(findingStatus.id),
    })
    .from(findingStatus)
    .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
    .where(and(publicGate, findingsCreatedRange))
    .groupBy(findingStatus.severity);

  // Per-tier dismissed count — DISTINCT findings from the POSTED-IN-WINDOW cohort
  // that have ≥1 authorised dismiss:reply at any time (reactionAt unbounded).
  // We window on findingStatus.createdAt (same predicate as postedRows) so
  // dismissedCount ≤ postedCount structurally, making dismissRate ≤ 1.0
  // impossible to exceed. We pull raw rows and count in JS to filter
  // authorAssociation without a dynamic inArray literal in the WHERE.
  const dismissedRows = await db
    .select({
      findingId: maintainerReactions.findingId,
      severity: findingStatus.severity,
      authorAssociation: maintainerReactions.authorAssociation,
    })
    .from(maintainerReactions)
    .innerJoin(findingStatus, eq(maintainerReactions.findingId, findingStatus.findingId))
    .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
    .where(
      and(publicGate, eq(maintainerReactions.actionTaken, "dismiss:reply"), findingsCreatedRange),
    );

  // Channel C — thumbs_down reactions in window.
  const thumbsRows = await db
    .select({ n: count(maintainerReactions.reactionId) })
    .from(maintainerReactions)
    .innerJoin(reviews, eq(maintainerReactions.reviewId, reviews.reviewId))
    .where(
      and(publicGate, eq(maintainerReactions.actionTaken, "reaction:thumbs_down"), reactionsRange),
    );

  // Aggregate dismissed — deduplicate per (findingId, tier) and filter auth.
  const dismissedPerTier = new Map<PrecisionTier, Set<string>>();
  for (const tier of PRECISION_TIERS) dismissedPerTier.set(tier, new Set());
  for (const row of dismissedRows) {
    if (!DISMISS_AUTHORISED_ASSOCIATIONS.has(row.authorAssociation ?? "")) continue;
    const tier = row.severity as PrecisionTier;
    if (!PRECISION_TIERS.includes(tier)) continue;
    dismissedPerTier.get(tier)!.add(row.findingId);
  }

  const postedPerTier = new Map<PrecisionTier, number>();
  for (const row of postedRows) {
    const tier = row.severity as PrecisionTier;
    if (!PRECISION_TIERS.includes(tier)) continue;
    postedPerTier.set(tier, row.n);
  }

  const tiers: PrecisionTierStats[] = PRECISION_TIERS.map((tier) => {
    const postedCount = postedPerTier.get(tier) ?? 0;
    const dismissedCount = dismissedPerTier.get(tier)!.size;
    const dismissRate = postedCount > 0 ? dismissedCount / postedCount : 0;
    return { tier, postedCount, dismissedCount, dismissRate };
  });

  return {
    tiers,
    thumbsDownCount: thumbsRows[0]?.n ?? 0,
  };
}

// ─── Mission 6 — /benchmarks public view ───────────────────────────────────
//
// Benchmark reviews are reviews on benchmark-class repos (BENCHMARK.md at
// root). They never close — benchmark replays are not meant to merge —
// so /receipts never shows them. /benchmarks surfaces them regardless of
// close state. Same privacy gate as /receipts: rows must have
// public_receipt = true AND is_benchmark = true.
//
// Finding count comes from agreementDecision JSONB (cheaper than joining
// finding_status; matches what the bot comment posts; the JSON already
// carries the "agreed" array length). Documented in the SQL select.

export type PublicBenchmarkRow = {
  reviewId: string;
  owner: string | null;
  repo: string | null;
  prNumber: number;
  commitSha: string;
  createdAt: Date;
  prCommentUrl: string | null;
  findingCount: number;
  filesReviewed: string[];
  // From provider_model_ids JSONB. Anthropic+OpenAI strings, used to render
  // model badges. Empty when the review was skipped before model dispatch.
  modelIds: Record<string, string>;
};

export type PublicBenchmarksPage = {
  totalBenchmarks: number;
  recent: PublicBenchmarkRow[];
  lastUpdatedAt: Date | null;
  hasMore: boolean;
};

export async function loadPublicBenchmarksPage(args: {
  limit: number;
  // Cursor: pass the createdAt of the last row on the current page; next
  // page returns strictly-older rows. Stable under inserts because newer
  // benchmarks always come in at the top.
  before?: Date | undefined;
}): Promise<PublicBenchmarksPage> {
  const fetchLimit = args.limit + 1;
  const reviewPublicGate = isDisclosureGateEnabled()
    ? reviewDerivedPublicReceiptCondition
    : eq(reviews.publicReceipt, true);
  const baseConditions = and(
    eq(reviews.isBenchmark, true),
    reviewPublicGate,
    nonCyberTierRepoCondition(),
  );
  const recentConditions =
    args.before === undefined
      ? baseConditions
      : and(baseConditions, lt(reviews.createdAt, args.before));

  const [countRows, fetchedRows, lastUpdatedRows] = await Promise.all([
    db.select({ value: count() }).from(reviews).where(baseConditions),
    db
      .select({
        reviewId: reviews.reviewId,
        owner: reviews.owner,
        repo: reviews.repo,
        prNumber: reviews.prNumber,
        commitSha: reviews.commitSha,
        createdAt: reviews.createdAt,
        prCommentUrl: reviews.prCommentUrl,
        // Finding count is the length of the agreed[] array inside
        // agreementDecision JSONB. NULL/missing keys collapse to 0.
        // Wrapped in a CAST so the result column is a stable int.
        findingCount:
          sql<number>`COALESCE(jsonb_array_length(${reviews.agreementDecision}->'agreed'), 0)::int`.as(
            "finding_count",
          ),
        filesReviewed: reviews.filesReviewed,
        modelIds: reviews.providerModelIds,
      })
      .from(reviews)
      .where(recentConditions)
      .orderBy(desc(reviews.createdAt))
      .limit(fetchLimit),
    db
      .select({ value: max(reviews.createdAt) })
      .from(reviews)
      .where(baseConditions),
  ]);

  const hasMore = fetchedRows.length > args.limit;
  const recent = (hasMore ? fetchedRows.slice(0, args.limit) : fetchedRows).map((r) => ({
    reviewId: r.reviewId,
    owner: r.owner,
    repo: r.repo,
    prNumber: r.prNumber,
    commitSha: r.commitSha,
    createdAt: r.createdAt,
    prCommentUrl: r.prCommentUrl,
    findingCount: r.findingCount,
    filesReviewed: r.filesReviewed,
    modelIds: (r.modelIds ?? {}) as Record<string, string>,
  }));
  const lastUpdatedRaw = lastUpdatedRows[0]?.value ?? null;
  const lastUpdatedAt =
    lastUpdatedRaw === null
      ? null
      : lastUpdatedRaw instanceof Date
        ? lastUpdatedRaw
        : new Date(lastUpdatedRaw);

  return {
    totalBenchmarks: countRows[0]?.value ?? 0,
    recent,
    lastUpdatedAt,
    hasMore,
  };
}

// /agents/[address] — return findings for one agent, plus any benchmark
// reviews tied to the agent's stored bench repo name and any merged upstream PRs AntFleet opened
// against the agent's own repo (cross-reference by upstream_repo = agent_name).
// The address is matched case-insensitively because users will paste mixed-
// case checksummed addresses from explorers.
export type AgentDetail = {
  agentTokenAddress: string;
  agentName: string;
  findings: AgentFinding[];
  benchmarkReviews: AgentBenchmarkReference[];
  crossRepoMerges: AgentCrossRepoMerge[];
  threatModels: AgentThreatModelReference[];
  // True when any covered repo is classified `cyber` in repo_tier AND the
  // ANTFLEET_CYBER_TIER flag is on. The agent page renders a single
  // "Cyber" pill near the header when true — does NOT identify which
  // specific repo so existence-hiding on the per-repo basis is preserved.
  hasCyberTierRepo: boolean;
};

export type AgentBenchmarkReference = {
  reviewId: string;
  owner: string | null;
  repo: string | null;
  prNumber: number;
  commitSha: string;
  createdAt: Date;
  prCommentUrl: string | null;
};

export type AgentCrossRepoMerge = {
  id: string;
  upstreamOwner: string;
  upstreamRepo: string;
  upstreamPrNumber: number;
  resolvedAt: Date;
  resolutionSha: string;
  closureMethod: string;
  prUrl: string;
};

export type AgentThreatModelReference = {
  owner: string;
  repo: string;
  lastReviewedSha: string;
  updatedAt: Date;
  publicModel: unknown;
};

// M12: cache() deduplicates calls from generateMetadata + page + OG image
// within a single render pass.
export const loadAgentDetail = cache(async (address: string): Promise<AgentDetail | null> => {
  // The roast pipeline (Sprint 2) stores its findings in agent_findings under
  // the pseudo-key `roast:<submissionId>`. Those live at /roasts/[id]; they
  // must never resolve to an /agents/[address] page.
  if (address.toLowerCase().startsWith("roast:")) return null;
  const normalized = address.toLowerCase();
  // Cyber-tier exclusion: agent_findings rows for cyber-classified repos
  // must NOT reach the public agent page. Without this filter, the page
  // header would render the cyber repo name and the finding bodies
  // would expose title / summary / evidence — defeating the spec's
  // existence-hiding invariant. (Code + security audit pass-1, severity
  // high, visibility / information-disclosure.) Same filter is applied
  // to the v1 API surfaces (/api/v1/findings, .../[id], and
  // /api/v1/agents/[address]/findings) so cyber rows are hidden from
  // every public agent_findings consumer.
  const findings = await db
    .select()
    .from(agentFindings)
    .where(
      and(
        sql`lower(${agentFindings.agentTokenAddress}) = ${normalized}`,
        nonCyberTierRepoConditionForFullName(sql`${agentFindings.repoFullName}`),
      ),
    )
    .orderBy(desc(agentFindings.publishedAt));

  if (findings.length === 0) return null;

  const first = findings[0]!;
  const benchRepoName = first.benchRepoName;
  const reviewPublicGate = isDisclosureGateEnabled()
    ? reviewDerivedPublicReceiptCondition
    : eq(reviews.publicReceipt, true);

  // Public benchmark reviews tied to this agent's bench repo. Gated on
  // publicReceipt + isBenchmark like /benchmarks. Repo names are
  // case-insensitive on GitHub, so match lower() on both sides.
  const [benchmarkRows, mergedOutgoingRows] = await Promise.all([
    db
      .select({
        reviewId: reviews.reviewId,
        owner: reviews.owner,
        repo: reviews.repo,
        prNumber: reviews.prNumber,
        commitSha: reviews.commitSha,
        createdAt: reviews.createdAt,
        prCommentUrl: reviews.prCommentUrl,
      })
      .from(reviews)
      .where(
        and(
          eq(reviews.isBenchmark, true),
          reviewPublicGate,
          nonCyberTierRepoCondition(),
          benchRepoName === null
            ? sql`false`
            : sql`lower(${reviews.repo}) = ${benchRepoName.toLowerCase()}`,
        ),
      )
      .orderBy(desc(reviews.createdAt)),
    // Merged upstream PRs AntFleet opened against this agent's own repo
    // (not the -bench fork). The /receipts page already surfaces these
    // globally; here we just slice them by the upstream_repo matching the
    // agent name, so the agent page becomes the per-agent attribution view.
    //
    // Cyber-tier exclusion via NOT EXISTS subquery on the source review's
    // repo (NOT the upstream repo — the upstream is the maintainer's
    // repo and is necessarily public). If the source review's repo is
    // cyber-classified, the outgoing PR row is hidden from the agent
    // page even when the upstream merge would normally surface it on
    // /receipts. Security audit pass-6, severity high,
    // cross-repo-receipt-bypass. Mirrors the gate in lib/receipts.ts.
    db
      .select({
        id: outgoingPrs.id,
        upstreamOwner: outgoingPrs.upstreamOwner,
        upstreamRepo: outgoingPrs.upstreamRepo,
        upstreamPrNumber: outgoingPrs.upstreamPrNumber,
        mergedAt: outgoingPrs.mergedAt,
        mergeSha: outgoingPrs.mergeSha,
        status: outgoingPrs.status,
        closureMethod: outgoingPrs.closureMethod,
        closureSha: outgoingPrs.closureSha,
        closureDetectedAt: outgoingPrs.closureDetectedAt,
      })
      .from(outgoingPrs)
      .where(
        and(
          inArray(outgoingPrs.status, ["merged", "closed_absorbed"]),
          sql`lower(${outgoingPrs.upstreamRepo}) = ${first.agentName.toLowerCase()}`,
          isCyberTierEnabled()
            ? sql<boolean>`(
                ${outgoingPrs.sourceFindingId} IS NULL
                OR NOT EXISTS (
                  SELECT 1
                  FROM ${findingStatus} src_fs
                  INNER JOIN ${reviews} src_r ON src_r.review_id = src_fs.review_id
                  INNER JOIN repo_tier src_rt
                    ON src_rt.owner_lc = lower(src_r.owner)
                    AND src_rt.repo_lc = lower(src_r.repo)
                  WHERE src_fs.finding_id = ${outgoingPrs.sourceFindingId}
                    AND src_rt.tier = 'cyber'
                )
              )`
            : sql<boolean>`true`,
        ),
      )
      .orderBy(
        sql`COALESCE(${outgoingPrs.mergedAt}, ${outgoingPrs.closureDetectedAt}) DESC NULLS LAST`,
      ),
  ]);

  const coveredRepos = Array.from(
    new Set(
      [
        ...findings
          .map((f) => parseRepoFullNameLoose(f.repoFullName))
          .filter((r): r is { owner: string; repo: string } => r !== null),
        ...benchmarkRows
          .map((r) =>
            r.owner === null || r.repo === null ? null : { owner: r.owner, repo: r.repo },
          )
          .filter((r): r is { owner: string; repo: string } => r !== null),
      ].map((r) => `${r.owner}/${r.repo}`),
    ),
  ).map((fullName) => {
    const [owner, repo] = fullName.split("/");
    return { owner: owner!, repo: repo! };
  });
  const threatModels = await loadPublicRepoThreatModelsForRepos(coveredRepos);

  // Cyber-tier badge presence — true when ANY repo touched by this
  // agent is classified 'cyber'. CRITICAL: this query MUST NOT use
  // `coveredRepos` (derived from the cyber-FILTERED `findings`) — if it
  // did, cyber rows would have been removed before the lookup runs and
  // the badge would never appear. Instead query agent_findings directly
  // (without the cyber filter) joined to repo_tier. Returns false when
  // the flag is off (the join returns no rows because the table is
  // ignored). (Code + architect audit pass-2, severity medium, ui-spec
  // / agent-badge-derivation.)
  let hasCyberTierRepo = false;
  if (isCyberTierEnabled()) {
    // PK-sargable form on repo_tier (owner_lc, repo_lc) — see
    // lib/cyber-tier.ts comment for the runtime-cost note.
    const cyberRows = await db.execute(sql`
      SELECT 1
      FROM agent_findings af
      WHERE lower(af.agent_token_address) = ${normalized}
        AND af.agent_token_address NOT LIKE 'roast:%'
        AND EXISTS (
          SELECT 1 FROM repo_tier
          WHERE owner_lc = split_part(lower(af.repo_full_name), '/', 1)
            AND repo_lc = split_part(lower(af.repo_full_name), '/', 2)
            AND tier = 'cyber'
        )
      LIMIT 1
    `);
    const rowsArr = Array.isArray(cyberRows)
      ? cyberRows
      : ((cyberRows as { rows?: unknown[] }).rows ?? []);
    hasCyberTierRepo = rowsArr.length > 0;
  }

  const crossRepoMerges: AgentCrossRepoMerge[] = mergedOutgoingRows
    .filter((r) => {
      if (r.status === "merged") return r.mergedAt !== null && r.mergeSha !== null;
      if (r.status === "closed_absorbed")
        return r.closureDetectedAt !== null && r.closureSha !== null;
      return false;
    })
    .map((r) => {
      const isAbsorbed = r.status === "closed_absorbed";
      return {
        id: r.id,
        upstreamOwner: r.upstreamOwner,
        upstreamRepo: r.upstreamRepo,
        upstreamPrNumber: r.upstreamPrNumber,
        resolvedAt: isAbsorbed ? (r.closureDetectedAt as Date) : (r.mergedAt as Date),
        resolutionSha: isAbsorbed ? (r.closureSha as string) : (r.mergeSha as string),
        closureMethod: r.closureMethod ?? (isAbsorbed ? "absorbed_inline" : "merged"),
        prUrl: `https://github.com/${r.upstreamOwner}/${r.upstreamRepo}/pull/${r.upstreamPrNumber}`,
      };
    });

  return {
    agentTokenAddress: first.agentTokenAddress,
    agentName: first.agentName,
    findings,
    benchmarkReviews: benchmarkRows,
    crossRepoMerges,
    threatModels,
    hasCyberTierRepo,
  };
});

function parseRepoFullNameLoose(value: string | null): { owner: string; repo: string } | null {
  if (value === null) return null;
  const [owner, repo] = value.split("/");
  if (owner === undefined || repo === undefined || owner === "" || repo === "") return null;
  return { owner, repo };
}

// Auto-stub agent shape for factory_launches rows that don't yet have any
// agent_findings. The /agents/[address] page renders this when loadAgentDetail
// returns null but the address matches a known on-chain launch — gives the
// agent a permanent URL the moment the factory deploys it, even before the
// pre-launch benchmark publishes.
export type FactoryLaunchAgentDetail = {
  agentTokenAddress: string;
  agentName: string;
  launch: FactoryLaunch;
};

// M12: cache() deduplicates calls within a single render pass.
export const loadFactoryLaunchDetail = cache(
  async (address: string): Promise<FactoryLaunchAgentDetail | null> => {
    const normalized = address.toLowerCase();
    // Cyber-tier exclusion: the public /agents/[address] page falls back
    // to this loader for factory-launched agents. Without the filter, a
    // cyber-classified factory launch's repo_full_name would render on
    // the public page header. (Code audit pass-5, severity high.)
    const rows = await db
      .select()
      .from(factoryLaunches)
      .where(
        and(
          sql`lower(${factoryLaunches.tokenAddress}) = ${normalized}`,
          nonCyberTierRepoConditionForFullName(sql`${factoryLaunches.repoFullName}`),
        ),
      )
      .limit(1);
    const launch = rows[0];
    if (launch === undefined) return null;
    return {
      agentTokenAddress: launch.tokenAddress,
      agentName: launch.tokenSymbol ?? launch.tokenName ?? launch.tokenAddress.slice(0, 10),
      launch,
    };
  },
);

export type FactoryLaunchIndexRow = {
  tokenAddress: string;
  tokenName: string | null;
  tokenSymbol: string | null;
  deployedAt: Date;
  repoFullName: string | null;
  prelaunchStatus: string;
};

// Index of factory-detected launches that do NOT yet have an agent_findings
// row. The /agents page unions this with the findings-bound index so newly-
// launched agents appear immediately, even before any benchmark publishes.
// Existing findings-bound rows take precedence — we don't want a "depth" agent
// (autonomopoly) to also show up as an "auto-stub".
export async function loadFactoryLaunchIndex(): Promise<FactoryLaunchIndexRow[]> {
  // Cyber-tier exclusion: factory launches with a cyber-classified
  // repo_full_name must NOT appear on the /agents directory. Without
  // this filter the agent index page leaks repo identifiers for
  // factory-launched cyber agents. (Security audit pass-4, severity
  // high, information-disclosure.)
  const rows = await db
    .select({
      tokenAddress: factoryLaunches.tokenAddress,
      tokenName: factoryLaunches.tokenName,
      tokenSymbol: factoryLaunches.tokenSymbol,
      deployedAt: factoryLaunches.deployedAt,
      repoFullName: factoryLaunches.repoFullName,
      prelaunchStatus: factoryLaunches.prelaunchStatus,
    })
    .from(factoryLaunches)
    .where(
      and(
        sql`lower(${factoryLaunches.tokenAddress}) NOT IN (
          SELECT lower(${agentFindings.agentTokenAddress}) FROM ${agentFindings}
        )`,
        nonCyberTierRepoConditionForFullName(sql`${factoryLaunches.repoFullName}`),
      ),
    )
    .orderBy(desc(factoryLaunches.deployedAt));
  return rows.map((r) => ({
    ...r,
    deployedAt: r.deployedAt instanceof Date ? r.deployedAt : new Date(r.deployedAt),
  }));
}

export type WeeklyFeatureRow = {
  weekStart: Date;
  findingId: string;
  curatedBy: string;
  rationale: string | null;
  featuredAt: Date;
  // Joined from agent_findings
  agentName: string;
  agentTokenAddress: string;
  title: string;
  severity: string;
  summary: string;
};

type RawWeeklyFeatureRow = Omit<WeeklyFeatureRow, "weekStart" | "featuredAt"> & {
  weekStart: Date | string;
  featuredAt: Date | string;
};

/**
 * Read the current ISO-week feature. The week boundary is Monday 00:00 UTC;
 * "current" is the row whose week_start = the most recent Monday <= now().
 * Returns null when there is no row for the current week (or the linked
 * finding is missing — defensive read since finding_id is FK-by-convention).
 */
export async function loadCurrentWeeklyFeature(): Promise<WeeklyFeatureRow | null> {
  // Cyber-tier exclusion: the homepage (/) renders this loader's
  // result in `ReceiptOfTheWeekCard` with the finding title + summary.
  // Without filtering, a cyber-classified repo's curated feature could
  // leak even after the repo flipped to cyber (the weekly_features row
  // persists). Security audit pass-4, severity high,
  // information-disclosure.
  const cyberExclude = rawCyberTierExclusionForFullName(sql`${agentFindings.repoFullName}`);
  const result = await db.execute(sql`
    WITH current_week AS (
      SELECT date_trunc('week', now() AT TIME ZONE 'UTC')::date AS this_monday
    )
    SELECT
      wf.week_start AS "weekStart",
      wf.finding_id AS "findingId",
      wf.curated_by AS "curatedBy",
      wf.rationale AS "rationale",
      wf.featured_at AS "featuredAt",
      ${agentFindings.agentName} AS "agentName",
      ${agentFindings.agentTokenAddress} AS "agentTokenAddress",
      ${agentFindings.title} AS "title",
      ${agentFindings.severity} AS "severity",
      ${agentFindings.summary} AS "summary"
    FROM weekly_features wf
    JOIN ${agentFindings} ON ${agentFindings.findingId} = wf.finding_id
    JOIN current_week cw ON wf.week_start = cw.this_monday
    WHERE true ${cyberExclude}
    LIMIT 1
  `);
  const rows = Array.isArray(result)
    ? (result as unknown as RawWeeklyFeatureRow[])
    : ((result as unknown as { rows?: RawWeeklyFeatureRow[] }).rows ?? []);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    ...row,
    weekStart: row.weekStart instanceof Date ? row.weekStart : new Date(row.weekStart),
    featuredAt: row.featuredAt instanceof Date ? row.featuredAt : new Date(row.featuredAt),
  };
}

export type RoastDetail = {
  submission: RoastSubmission;
  findings: AgentFinding[];
};

export async function loadRoastDetail(id: string): Promise<RoastDetail | null> {
  const submissions = await db
    .select()
    .from(roastSubmissions)
    .where(eq(roastSubmissions.id, id))
    .limit(1);
  const submission = submissions[0];
  if (submission === undefined) return null;

  if (submission.status !== "published") {
    return { submission, findings: [] };
  }

  const findings = await db
    .select()
    .from(agentFindings)
    .where(sql`lower(${agentFindings.agentTokenAddress}) = lower(${"roast:" + id})`)
    .orderBy(desc(agentFindings.publishedAt));

  return { submission, findings };
}

// Roast runner helpers (D6). All state transitions are optimistic-concurrency
// guarded by the `status` column so a parallel cron tick can't double-claim.

export async function selectOldestQueuedRoast(): Promise<RoastSubmission | null> {
  const rows = await db
    .select()
    .from(roastSubmissions)
    .where(eq(roastSubmissions.status, "queued"))
    .orderBy(roastSubmissions.createdAt)
    .limit(1);
  return rows[0] ?? null;
}

export async function claimRoastForRunning(id: string): Promise<boolean> {
  const updated = await db
    .update(roastSubmissions)
    .set({ status: "running" })
    .where(and(eq(roastSubmissions.id, id), eq(roastSubmissions.status, "queued")))
    .returning({ id: roastSubmissions.id });
  return updated.length > 0;
}

export async function markRoastPublished(id: string, receiptId: string): Promise<void> {
  await db
    .update(roastSubmissions)
    .set({ status: "published", publishedAt: new Date(), receiptId })
    .where(and(eq(roastSubmissions.id, id), eq(roastSubmissions.status, "running")));
}

export async function markRoastRejected(id: string, reason: string): Promise<void> {
  await db
    .update(roastSubmissions)
    .set({ status: "rejected", rejectionReason: reason })
    .where(and(eq(roastSubmissions.id, id), ne(roastSubmissions.status, "published")));
}

export async function countRoastsPublishedSince(since: Date): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(roastSubmissions)
    .where(and(eq(roastSubmissions.status, "published"), gte(roastSubmissions.publishedAt, since)));
  return row?.value ?? 0;
}

// Public counter strip on /roast and footer of /roasts index. Findings
// from roast submissions live in agent_findings under
// agent_token_address LIKE 'roast:%' (Sprint 2 pseudo-key); this query
// counts them in a single roundtrip alongside the published-submission
// count so the form page renders one bragging line above the input.
export interface RoastStats {
  totalPublished: number;
  totalFindingsFromRoasts: number;
  totalSubmissions: number;
}

export async function loadRoastStats(): Promise<RoastStats> {
  const [pubRows, findingRows, totalRows] = await Promise.all([
    db
      .select({ value: count() })
      .from(roastSubmissions)
      .where(eq(roastSubmissions.status, "published")),
    db
      .select({ value: count() })
      .from(agentFindings)
      .where(sql`lower(${agentFindings.agentTokenAddress}) like 'roast:%'`),
    db.select({ value: count() }).from(roastSubmissions),
  ]);
  return {
    totalPublished: pubRows[0]?.value ?? 0,
    totalFindingsFromRoasts: findingRows[0]?.value ?? 0,
    totalSubmissions: totalRows[0]?.value ?? 0,
  };
}

export interface PublishedRoastRow {
  id: string;
  repoFullName: string;
  publishedAt: Date | null;
  findingCount: number;
  highestSeverity: string | null;
}

export interface PublishedRoastsPage {
  rows: PublishedRoastRow[];
  hasMore: boolean;
}

export function summarizeRoastFindings(findings: ReadonlyArray<{ severity: string }>): {
  findingCount: number;
  highestSeverity: string | null;
} {
  let bestRank = -1;
  let bestSeverity: string | null = null;
  for (const f of findings) {
    const rank = DIGEST_SEVERITY_RANK[f.severity.toLowerCase()] ?? -1;
    if (rank > bestRank) {
      bestRank = rank;
      bestSeverity = f.severity;
    }
  }
  return { findingCount: findings.length, highestSeverity: bestSeverity };
}

// Index listing for /roasts. Newest-first by publishedAt, cursor via
// publishedAt < before (mirrors /receipts pattern so the visual language
// stays consistent). Each row carries an aggregated finding count + the
// highest-severity label so the index row matches what the OG card
// shows.
export async function loadPublishedRoasts(
  limit: number,
  before?: Date,
): Promise<PublishedRoastsPage> {
  if (limit <= 0) return { rows: [], hasMore: false };
  const fetchLimit = limit + 1;
  const conditions =
    before === undefined
      ? eq(roastSubmissions.status, "published")
      : and(eq(roastSubmissions.status, "published"), lt(roastSubmissions.publishedAt, before));
  const submissions = await db
    .select({
      id: roastSubmissions.id,
      repoFullName: roastSubmissions.repoFullName,
      publishedAt: roastSubmissions.publishedAt,
    })
    .from(roastSubmissions)
    .where(conditions)
    .orderBy(desc(roastSubmissions.publishedAt))
    .limit(fetchLimit);
  const hasMore = submissions.length > limit;
  const visible = hasMore ? submissions.slice(0, limit) : submissions;
  const roastKeys = visible.map((sub) => `roast:${sub.id}`.toLowerCase());
  const findingsByRoast = new Map<string, Array<{ severity: string }>>();
  if (roastKeys.length > 0) {
    const findingRows = await db
      .select({
        roastKey: sql<string>`lower(${agentFindings.agentTokenAddress})`,
        severity: agentFindings.severity,
      })
      .from(agentFindings)
      .where(inArray(sql<string>`lower(${agentFindings.agentTokenAddress})`, roastKeys));
    for (const row of findingRows) {
      const bucket = findingsByRoast.get(row.roastKey) ?? [];
      bucket.push({ severity: row.severity });
      findingsByRoast.set(row.roastKey, bucket);
    }
  }

  const rows: PublishedRoastRow[] = visible.map((sub) => {
    const summary = summarizeRoastFindings(
      findingsByRoast.get(`roast:${sub.id}`.toLowerCase()) ?? [],
    );
    return {
      id: sub.id,
      repoFullName: sub.repoFullName,
      publishedAt: sub.publishedAt,
      findingCount: summary.findingCount,
      highestSeverity: summary.highestSeverity,
    };
  });
  return { rows, hasMore };
}

export async function insertRoastFindings(rows: NewAgentFinding[]): Promise<void> {
  if (rows.length === 0) return;
  // Bypass upsertAgentFinding's per-row post-draft side effect — roasts get
  // a single aggregated draft from the runner, not one per finding.
  await db.insert(agentFindings).values(rows).onConflictDoNothing();
}

// /agents — index of all agents that have at least one finding. We don't
// have a separate agents table; agents are implicit in the
// (agent_token_address, agent_name) pairs in agent_findings.
export type AgentIndexRow = {
  agentTokenAddress: string;
  agentName: string;
  findingCount: number;
  highestSeverity: string;
  lastFindingAt: Date;
};

export async function loadAgentIndex(): Promise<AgentIndexRow[]> {
  // GROUP BY (agent_token_address, agent_name) so a typo in agent_name
  // would surface as two rows rather than silently collapse. Severity is
  // ranked client-side rather than via a pg enum.
  //
  // The `roast:%` filter matches the canonical convention from runbook §3:
  // roast findings share this table for storage convenience but are
  // surfaced at /roasts/[id], not /agents.
  // Cyber-tier exclusion: aggregate by agent over public agent_findings
  // rows only. Without this filter, /agents would surface an agent row
  // for an address whose only findings are cyber-classified, leaking
  // the agent name + finding count via the public index page. Security
  // audit pass-4, severity medium.
  const rows = await db
    .select({
      agentTokenAddress: agentFindings.agentTokenAddress,
      agentName: agentFindings.agentName,
      findingCount: sql<number>`count(*)::int`.as("finding_count"),
      lastFindingAt: sql<Date>`max(${agentFindings.publishedAt})`.as("last_finding_at"),
      severities: sql<string[]>`array_agg(${agentFindings.severity})`.as("severities"),
    })
    .from(agentFindings)
    .where(
      and(
        sql`lower(${agentFindings.agentTokenAddress}) NOT LIKE 'roast:%'`,
        nonCyberTierRepoConditionForFullName(sql`${agentFindings.repoFullName}`),
      ),
    )
    .groupBy(agentFindings.agentTokenAddress, agentFindings.agentName)
    .orderBy(sql`max(${agentFindings.publishedAt}) desc`);

  return rows.map((r) => ({
    agentTokenAddress: r.agentTokenAddress,
    agentName: r.agentName,
    findingCount: r.findingCount,
    highestSeverity: pickHighestSeverity(r.severities),
    lastFindingAt: r.lastFindingAt instanceof Date ? r.lastFindingAt : new Date(r.lastFindingAt),
  }));
}

const SEVERITY_RANK: Record<string, number> = { info: 0, low: 1, med: 2, high: 3 };

function pickHighestSeverity(severities: string[]): string {
  let best = "info";
  let bestRank = -1;
  for (const s of severities) {
    const rank = SEVERITY_RANK[s] ?? -1;
    if (rank > bestRank) {
      bestRank = rank;
      best = s;
    }
  }
  return best;
}

// Idempotent upsert used by publish-feelocker-finding.ts. New rows get
// publishedAt = now() from the column default; updates set every column
// except publishedAt + findingId so the historical timestamp is preserved.
export async function upsertAgentFinding(input: NewAgentFinding): Promise<void> {
  const existing = await db
    .select({ findingId: agentFindings.findingId })
    .from(agentFindings)
    .where(eq(agentFindings.findingId, input.findingId));
  await db
    .insert(agentFindings)
    .values(input)
    .onConflictDoUpdate({
      target: agentFindings.findingId,
      set: {
        agentTokenAddress: input.agentTokenAddress,
        agentName: input.agentName,
        repoFullName: input.repoFullName ?? null,
        benchRepoName: input.benchRepoName ?? null,
        title: input.title,
        severity: input.severity,
        summary: input.summary,
        evidence: input.evidence ?? null,
        upstreamPrUrl: input.upstreamPrUrl ?? null,
        upstreamMergedSha: input.upstreamMergedSha ?? null,
      },
    });
  if (existing.length === 0) {
    await writePostDraft({
      slug: input.findingId,
      title: input.title,
      body: `New ${input.severity} agent finding for ${input.agentName}: ${input.summary}`,
    });
  }
}

export type InstallStatus = "pending_approval" | "approved" | "rejected";

export async function upsertInstallEntry(
  installationId: number,
  owner: string,
  repo: string,
): Promise<InstallStatus> {
  const rows = await db
    .insert(installations)
    .values({ installationId, owner, repo, status: "pending_approval" })
    .onConflictDoUpdate({
      target: [installations.installationId, installations.repo],
      set: { owner: sql`EXCLUDED.owner` },
    })
    .returning({ status: installations.status });
  return (rows[0]?.status ?? "pending_approval") as InstallStatus;
}

export async function isInstallApproved(installationId: number, repo: string): Promise<boolean> {
  const rows = await db
    .select({ status: installations.status })
    .from(installations)
    .where(and(eq(installations.installationId, installationId), eq(installations.repo, repo)))
    .limit(1);
  return rows[0]?.status === "approved";
}

export async function isInstallApprovedForRepo(args: {
  installationId: number;
  owner: string;
  repo: string;
}): Promise<boolean> {
  const rows = await db
    .select({ status: installations.status })
    .from(installations)
    .where(
      and(
        eq(installations.installationId, args.installationId),
        eq(installations.owner, args.owner),
        eq(installations.repo, args.repo),
      ),
    )
    .limit(1);
  return rows[0]?.status === "approved";
}

export type InstallRow = {
  id: string;
  // Nullable on agent-onboarded rows that haven't yet completed the GitHub
  // App install step. Legacy rows always have all three populated.
  installationId: number | null;
  owner: string | null;
  repo: string | null;
  status: string;
  notes: string | null;
  createdAt: Date;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  walletAddress: string | null;
  walletProofSignature: string | null;
  walletBoundAt: Date | null;
  legacyPartner: boolean;
  patchAgentEnabled: boolean | null;
  patchAgentClickApplyEnabled: boolean | null;
};

const installRowColumns = {
  id: installations.id,
  installationId: installations.installationId,
  owner: installations.owner,
  repo: installations.repo,
  status: installations.status,
  notes: installations.notes,
  createdAt: installations.createdAt,
  approvedAt: installations.approvedAt,
  rejectedAt: installations.rejectedAt,
  walletAddress: installations.walletAddress,
  walletProofSignature: installations.walletProofSignature,
  walletBoundAt: installations.walletBoundAt,
  legacyPartner: installations.legacyPartner,
  patchAgentEnabled: installations.patchAgentEnabled,
  patchAgentClickApplyEnabled: installations.patchAgentClickApplyEnabled,
};

export async function listInstallRows(filter?: InstallStatus): Promise<InstallRow[]> {
  if (filter !== undefined) {
    return db
      .select(installRowColumns)
      .from(installations)
      .where(eq(installations.status, filter))
      .orderBy(desc(installations.createdAt));
  }
  return db.select(installRowColumns).from(installations).orderBy(desc(installations.createdAt));
}

export async function setInstallStatus(
  installationId: number,
  repo: string,
  status: "approved" | "rejected",
  notes?: string,
): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(installations)
    .set({
      status,
      ...(notes !== undefined ? { notes } : {}),
      ...(status === "approved" ? { approvedAt: now } : { rejectedAt: now }),
    })
    .where(and(eq(installations.installationId, installationId), eq(installations.repo, repo)))
    .returning({ id: installations.id });
  return updated.length > 0;
}

export async function setInstallPatchAgentEnabled(
  installationId: number,
  repo: string,
  enabled: boolean,
): Promise<boolean> {
  const updated = await db
    .update(installations)
    .set({ patchAgentEnabled: enabled })
    .where(and(eq(installations.installationId, installationId), eq(installations.repo, repo)))
    .returning({ id: installations.id });
  return updated.length > 0;
}

// ---------------------------------------------------------------------------
// Scorecard snapshot queries
// ---------------------------------------------------------------------------

import type { ScorecardPayload } from "@/lib/scorecard";

export type ScorecardSnapshotRow = {
  yyyyMmDd: string;
  generatedAt: Date;
  generatorVersion: string;
  payload: ScorecardPayload;
};

// Cyber-tier staleness: returns the latest `repo_tier_change_log.changed_at`
// timestamp, or null if there are no tier changes (or the flag is off).
// Snapshots generated BEFORE this timestamp were computed under a
// different cyber-visibility regime and must not be served verbatim.
// (Architect audit pass-9, severity medium, operational-architecture.)
async function latestCyberTierChangeAt(): Promise<Date | null> {
  if (!isCyberTierEnabled()) return null;
  const rows = await db
    .select({ changedAt: repoTierChangeLog.changedAt })
    .from(repoTierChangeLog)
    .orderBy(desc(repoTierChangeLog.changedAt))
    .limit(1);
  return rows[0]?.changedAt ?? null;
}

export async function loadScorecardSnapshot(
  yyyyMmDd: string,
): Promise<ScorecardSnapshotRow | null> {
  const [rows, cyberCutoff] = await Promise.all([
    db.select().from(scorecardSnapshots).where(eq(scorecardSnapshots.yyyyMmDd, yyyyMmDd)).limit(1),
    latestCyberTierChangeAt(),
  ]);
  if (rows.length === 0) return null;
  const row = rows[0];
  // Staleness: if a tier change happened after this snapshot was
  // generated, the snapshot may include data that's now privacy-hidden.
  // Skip serving it. Weekly cron + an on-demand backfill regenerate
  // fresh snapshots under the current cyber filter.
  if (cyberCutoff !== null && row.generatedAt.getTime() < cyberCutoff.getTime()) {
    return null;
  }
  return {
    yyyyMmDd: row.yyyyMmDd,
    generatedAt: row.generatedAt,
    generatorVersion: row.generatorVersion,
    payload: row.payload as ScorecardPayload,
  };
}

export async function loadScorecardIndex(args: {
  limit: number;
  before?: string;
}): Promise<{ rows: ScorecardSnapshotRow[]; hasMore: boolean }> {
  const fetchLimit = args.limit + 1;
  const conditions =
    args.before !== undefined ? lt(scorecardSnapshots.yyyyMmDd, args.before) : undefined;

  const [rows, cyberCutoff] = await Promise.all([
    db
      .select()
      .from(scorecardSnapshots)
      .where(conditions)
      .orderBy(desc(scorecardSnapshots.yyyyMmDd))
      .limit(fetchLimit),
    latestCyberTierChangeAt(),
  ]);

  // Filter stale snapshots BEFORE the limit decision so pagination
  // remains stable: a stale row in the page would shrink it but
  // `hasMore` would still be true from the over-fetch.
  const fresh =
    cyberCutoff === null
      ? rows
      : rows.filter((r) => r.generatedAt.getTime() >= cyberCutoff.getTime());
  const hasMore = fresh.length > args.limit;
  const page = hasMore ? fresh.slice(0, args.limit) : fresh;

  return {
    rows: page.map((row) => ({
      yyyyMmDd: row.yyyyMmDd,
      generatedAt: row.generatedAt,
      generatorVersion: row.generatorVersion,
      payload: row.payload as ScorecardPayload,
    })),
    hasMore,
  };
}

export async function insertScorecardSnapshot(
  yyyyMmDd: string,
  payload: ScorecardPayload,
  generatorVersion: string,
): Promise<boolean> {
  const result = await db
    .insert(scorecardSnapshots)
    .values({
      yyyyMmDd,
      payload,
      generatorVersion,
    })
    .onConflictDoNothing()
    .returning({ yyyyMmDd: scorecardSnapshots.yyyyMmDd });
  return result.length > 0;
}

// Side-table writer for the Daybreak reachability + patch-verify stages.
// Pure INSERT — there's no UPSERT or UPDATE path; each stage invocation
// emits exactly one row. Callers gate on the relevant flag before
// invoking this; a DB write failure must not bubble up and block the
// underlying review or patch comment (lifecycle invariant 2). The
// migration that ships the underlying table (0041) is authored but NOT
// yet applied to prod — callers behind the flag-off path will never reach
// this function in prod until the operator runs the apply script.
export type GateOutcomeRow = {
  findingId: string | null;
  stage: "reachability" | "patch_verify";
  verdict: string;
  evidence: unknown;
  modelId: string | null;
  // Review attempt this outcome was emitted from. The kernel re-runs the
  // pipeline on retry, so the same finding can produce multiple rows
  // over a review's lifetime. Stored so dup rows stay interpretable.
  // Defaults to 1 for callers that don't track attempts (the bench
  // dry-run, ad-hoc replays).
  reviewAttempt?: number;
};

export async function recordGateOutcome(reviewId: string, row: GateOutcomeRow): Promise<string> {
  const values: NewReviewGateOutcome = {
    reviewId,
    findingId: row.findingId,
    stage: row.stage,
    verdict: row.verdict,
    evidence: row.evidence,
    modelId: row.modelId,
    reviewAttempt: row.reviewAttempt ?? 1,
  };
  const inserted = await db
    .insert(reviewGateOutcomes)
    .values(values)
    .returning({ id: reviewGateOutcomes.id });
  const first = inserted[0];
  if (first === undefined) {
    throw new Error("recordGateOutcome: insert returned no row");
  }
  return first.id;
}

export type CreateSarifImportBatchInput = Pick<
  NewSarifImportBatch,
  | "installationId"
  | "owner"
  | "repo"
  | "repoHash"
  | "sourceTool"
  | "sourceKind"
  | "sourceRevision"
  | "sourceUrl"
  | "fileBlobRef"
  | "ingestTokenJti"
  | "totalClaims"
>;

export class SarifIngestTokenReplayError extends Error {
  constructor() {
    super("SARIF ingest token was already used");
    this.name = "SarifIngestTokenReplayError";
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

export async function createSarifImportBatch(input: CreateSarifImportBatchInput): Promise<string> {
  const inserted = await db
    .insert(sarifImportBatch)
    .values({ ...input, status: "pending" })
    .returning({ id: sarifImportBatch.id });
  const first = inserted[0];
  if (first === undefined) throw new Error("createSarifImportBatch: insert returned no row");
  return first.id;
}

export async function consumeSarifIngestTokenUse(
  tokenUse: NewSarifIngestTokenUse,
): Promise<"consumed" | "replay"> {
  try {
    await db.insert(sarifIngestTokenUse).values({
      jti: tokenUse.jti,
      installationId: tokenUse.installationId,
      repo: tokenUse.repo,
    });
    return "consumed";
  } catch (err) {
    if (isUniqueViolation(err)) return "replay";
    throw err;
  }
}

export async function purgeOldSarifIngestTokenUses(cutoff: Date): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM ${sarifIngestTokenUse}
    WHERE ${sarifIngestTokenUse.jti} IN (
      SELECT ${sarifIngestTokenUse.jti}
      FROM ${sarifIngestTokenUse}
      WHERE ${sarifIngestTokenUse.usedAt} < ${cutoff}
      LIMIT ${SARIF_TOKEN_USE_GC_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING ${sarifIngestTokenUse.jti}
  `);
  return rowCount(result);
}

function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  const rows = (result as { rows?: unknown[] }).rows;
  return Array.isArray(rows) ? rows.length : 0;
}

export async function insertSarifFindings(rows: NewSarifFinding[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(sarifFinding).values(rows).onConflictDoNothing();
}

export type UpdateSarifFindingValidationInput = {
  batchId: string;
  externalFingerprint: string;
  validationVerdict: string;
  confirmationVerdict?: string | null;
  reachabilityVerdict?: string | null;
  patchVerifyVerdict?: string | null;
  closureReceipt?: unknown;
  linkedFindingStatusId?: string | null;
};

export async function updateSarifFindingValidation(
  input: UpdateSarifFindingValidationInput,
): Promise<void> {
  await db
    .update(sarifFinding)
    .set({
      validationVerdict: input.validationVerdict,
      confirmationVerdict: input.confirmationVerdict,
      reachabilityVerdict: input.reachabilityVerdict,
      patchVerifyVerdict: input.patchVerifyVerdict,
      closureReceipt: input.closureReceipt,
      linkedFindingStatusId: input.linkedFindingStatusId,
      processedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sarifFinding.batchId, input.batchId),
        eq(sarifFinding.externalFingerprint, input.externalFingerprint),
      ),
    );
}

export async function finishSarifImportBatch(
  batchId: string,
  args: {
    status: string;
    realCount: number;
    falsePositiveCount: number;
    inconclusiveCount: number;
    errorCount: number;
  },
): Promise<void> {
  await db
    .update(sarifImportBatch)
    .set({
      status: args.status,
      realCount: args.realCount,
      falsePositiveCount: args.falsePositiveCount,
      inconclusiveCount: args.inconclusiveCount,
      errorCount: args.errorCount,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(sarifImportBatch.id, batchId));
}

export type SarifBatchSummary = {
  id: string;
  sourceTool: string;
  sourceKind: string;
  sourceRevision: string | null;
  status: string;
  totalClaims: number;
  realCount: number;
  falsePositiveCount: number;
  inconclusiveCount: number;
  errorCount: number;
  createdAt: Date;
  finishedAt: Date | null;
};

export async function listSarifImportBatchesForRepo(args: {
  owner: string;
  repo: string;
  limit?: number;
}): Promise<SarifBatchSummary[]> {
  const rows = await db
    .select({
      id: sarifImportBatch.id,
      sourceTool: sarifImportBatch.sourceTool,
      sourceKind: sarifImportBatch.sourceKind,
      sourceRevision: sarifImportBatch.sourceRevision,
      status: sarifImportBatch.status,
      totalClaims: sarifImportBatch.totalClaims,
      realCount: sarifImportBatch.realCount,
      falsePositiveCount: sarifImportBatch.falsePositiveCount,
      inconclusiveCount: sarifImportBatch.inconclusiveCount,
      errorCount: sarifImportBatch.errorCount,
      createdAt: sarifImportBatch.createdAt,
      finishedAt: sarifImportBatch.finishedAt,
    })
    .from(sarifImportBatch)
    .where(and(eq(sarifImportBatch.owner, args.owner), eq(sarifImportBatch.repo, args.repo)))
    .orderBy(desc(sarifImportBatch.createdAt))
    .limit(args.limit ?? 10);
  return rows;
}

export type RepoThreatModelUpsertInput = {
  repoHash: string;
  owner: string;
  repo: string;
  version: number;
  model: unknown;
  publicModel: unknown;
  provenance: unknown;
  generatorModelId: string | null;
  lastReviewedSha: string;
  entryPointsRefreshedSha: string | null;
  trustBoundariesRefreshedSha: string | null;
  sinksRefreshedSha: string | null;
  secretsSurfaceRefreshedSha: string | null;
  criticalAssetsRefreshedSha: string | null;
  refreshCount: number;
  publicAccess: "private" | "public" | "live_protocol_review_required";
};

export async function loadRepoThreatModel(repoHash: string): Promise<RepoThreatModel | null> {
  const rows = await db
    .select()
    .from(repoThreatModel)
    .where(eq(repoThreatModel.repoHash, repoHash))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertRepoThreatModel(input: RepoThreatModelUpsertInput): Promise<void> {
  const values: NewRepoThreatModel = {
    repoHash: input.repoHash,
    owner: input.owner,
    repo: input.repo,
    version: input.version,
    model: input.model,
    publicModel: input.publicModel,
    provenance: input.provenance,
    generatorModelId: input.generatorModelId,
    lastReviewedSha: input.lastReviewedSha,
    entryPointsRefreshedSha: input.entryPointsRefreshedSha,
    trustBoundariesRefreshedSha: input.trustBoundariesRefreshedSha,
    sinksRefreshedSha: input.sinksRefreshedSha,
    secretsSurfaceRefreshedSha: input.secretsSurfaceRefreshedSha,
    criticalAssetsRefreshedSha: input.criticalAssetsRefreshedSha,
    refreshCount: input.refreshCount,
    publicAccess: input.publicAccess,
    updatedAt: new Date(),
  };
  await db
    .insert(repoThreatModel)
    .values(values)
    .onConflictDoUpdate({
      target: repoThreatModel.repoHash,
      set: {
        owner: input.owner,
        repo: input.repo,
        version: input.version,
        model: input.model,
        publicModel: input.publicModel,
        provenance: input.provenance,
        generatorModelId: input.generatorModelId,
        lastReviewedSha: input.lastReviewedSha,
        entryPointsRefreshedSha: input.entryPointsRefreshedSha,
        trustBoundariesRefreshedSha: input.trustBoundariesRefreshedSha,
        sinksRefreshedSha: input.sinksRefreshedSha,
        secretsSurfaceRefreshedSha: input.secretsSurfaceRefreshedSha,
        criticalAssetsRefreshedSha: input.criticalAssetsRefreshedSha,
        refreshCount: input.refreshCount,
        publicAccess: input.publicAccess,
        updatedAt: new Date(),
      },
    });
}

export async function loadPublicRepoThreatModelsForRepos(
  repos: ReadonlyArray<{ owner: string; repo: string }>,
): Promise<AgentThreatModelReference[]> {
  if (repos.length === 0) return [];
  const keys = repos.map((r) => `${r.owner.toLowerCase()}/${r.repo.toLowerCase()}`);
  // Defense-in-depth: even if a repo's publicAccess row is stale from
  // before being flipped to cyber tier, the cyber-tier exclusion here
  // hides it on the public render. When ANTFLEET_CYBER_TIER is OFF the
  // condition collapses to `true` and behavior is byte-identical.
  const rows = await db
    .select({
      owner: repoThreatModel.owner,
      repo: repoThreatModel.repo,
      lastReviewedSha: repoThreatModel.lastReviewedSha,
      updatedAt: repoThreatModel.updatedAt,
      publicModel: repoThreatModel.publicModel,
    })
    .from(repoThreatModel)
    .where(
      and(
        eq(repoThreatModel.publicAccess, "public"),
        inArray(
          sql<string>`lower(${repoThreatModel.owner}) || '/' || lower(${repoThreatModel.repo})`,
          keys,
        ),
        nonCyberTierRepoConditionFor(sql`${repoThreatModel.owner}`, sql`${repoThreatModel.repo}`),
      ),
    )
    .orderBy(desc(repoThreatModel.updatedAt));
  return rows;
}

export async function isLiveProtocolInstallRepo(args: {
  installationId: number | null;
  owner: string;
  repo: string;
}): Promise<boolean> {
  const scope =
    args.installationId === null
      ? and(eq(installations.owner, args.owner), eq(installations.repo, args.repo))
      : and(
          eq(installations.installationId, args.installationId),
          eq(installations.owner, args.owner),
          eq(installations.repo, args.repo),
        );
  const rows = await db
    .select({ isLiveProtocol: installations.isLiveProtocol })
    .from(installations)
    .where(scope)
    .limit(1);
  return rows[0]?.isLiveProtocol === true;
}

export type CreateFindingDisclosureInput = {
  findingId: string;
  reviewId: string;
  state: DisclosureState;
  enteredAt: Date;
  embargoExpiresAt: Date | null;
  maintainerUrlCiphertext?: string | null;
  maintainerUrlLogId?: string | null;
  advisoryDraft: string | null;
  atSha: string;
  reason: string;
};

export async function createFindingDisclosure(
  input: CreateFindingDisclosureInput,
): Promise<{ created: boolean }> {
  const values: NewFindingDisclosure = {
    findingId: input.findingId,
    reviewId: input.reviewId,
    state: input.state,
    enteredAt: input.enteredAt,
    embargoExpiresAt: input.embargoExpiresAt,
    maintainerUrlCiphertext: input.maintainerUrlCiphertext ?? null,
    maintainerUrlLogId: input.maintainerUrlLogId ?? null,
    advisoryDraft: input.advisoryDraft,
    advisoryDraftUpdatedAt: input.advisoryDraft === null ? null : input.enteredAt,
  };
  return await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(findingDisclosure)
      .values(values)
      .onConflictDoNothing({ target: findingDisclosure.findingId })
      .returning({ findingId: findingDisclosure.findingId });
    if (inserted.length === 0) {
      const existing = await tx
        .select({ state: findingDisclosure.state })
        .from(findingDisclosure)
        .where(eq(findingDisclosure.findingId, input.findingId))
        .limit(1);
      const existingState = existing[0]?.state as DisclosureState | undefined;
      if (existingState !== undefined) {
        const initialLog = await tx
          .select({ id: findingDisclosureLog.id })
          .from(findingDisclosureLog)
          .where(
            and(
              eq(findingDisclosureLog.findingId, input.findingId),
              isNull(findingDisclosureLog.fromState),
            ),
          )
          .limit(1);
        if (initialLog.length === 0) {
          const recoveredLog: NewFindingDisclosureLog = {
            findingId: input.findingId,
            fromState: null,
            toState: existingState,
            actorType: "system",
            actorId: null,
            reason: "recovered missing initial disclosure log",
            atSha: input.atSha,
            metadata: { recovered: true },
          };
          await tx.insert(findingDisclosureLog).values(recoveredLog);
        }
      }
      return { created: false };
    }
    const logValues: NewFindingDisclosureLog = {
      findingId: input.findingId,
      fromState: null,
      toState: input.state,
      actorType: "system",
      actorId: null,
      reason: input.reason,
      atSha: input.atSha,
      metadata: {},
    };
    await tx.insert(findingDisclosureLog).values(logValues);
    return { created: true };
  });
}

export async function recordFindingDisclosureLog(input: {
  findingId: string;
  fromState: DisclosureState | null;
  toState: DisclosureState;
  actorType: DisclosureActorType;
  actorId: string | null;
  reason: string;
  atSha: string;
  metadata: unknown;
}): Promise<void> {
  const values: NewFindingDisclosureLog = {
    findingId: input.findingId,
    fromState: input.fromState,
    toState: input.toState,
    actorType: input.actorType,
    actorId: input.actorId,
    reason: input.reason,
    atSha: input.atSha,
    metadata: input.metadata,
  };
  await db.insert(findingDisclosureLog).values(values);
}

export async function updateFindingDisclosureReservation(args: {
  findingId: string;
  ghsaId: string | null;
  cveId: string | null;
  ghsaHtmlUrl?: string | null;
  cveRequestedAt?: Date | null;
}): Promise<void> {
  await db
    .update(findingDisclosure)
    .set({
      ghsaId: args.ghsaId,
      cveId: args.cveId,
      ...(args.ghsaHtmlUrl !== undefined ? { ghsaHtmlUrl: args.ghsaHtmlUrl } : {}),
      ...(args.cveRequestedAt !== undefined ? { cveRequestedAt: args.cveRequestedAt } : {}),
      updatedAt: new Date(),
    })
    .where(eq(findingDisclosure.findingId, args.findingId));
}

export async function claimFindingDisclosureGhsaReservation(args: {
  findingId: string;
  reservationToken: string;
  now: Date;
  staleBefore: Date;
}): Promise<boolean> {
  const updated = await db
    .update(findingDisclosure)
    .set({
      ghsaReservationToken: args.reservationToken,
      updatedAt: args.now,
    })
    .where(
      and(
        eq(findingDisclosure.findingId, args.findingId),
        isNull(findingDisclosure.cveRequestedAt),
        or(
          isNull(findingDisclosure.ghsaReservationToken),
          lt(findingDisclosure.updatedAt, args.staleBefore),
        ),
      ),
    )
    .returning({ findingId: findingDisclosure.findingId });
  return updated.length > 0;
}

export async function completeFindingDisclosureGhsaReservation(args: {
  findingId: string;
  reservationToken: string;
  ghsaId: string;
  cveId: string | null;
  ghsaHtmlUrl: string | null;
  cveRequestedAt: Date | null;
  now: Date;
}): Promise<boolean> {
  const updated = await db
    .update(findingDisclosure)
    .set({
      ghsaId: args.ghsaId,
      cveId: args.cveId,
      ghsaHtmlUrl: args.ghsaHtmlUrl,
      cveRequestedAt: args.cveRequestedAt,
      ghsaReservationToken: null,
      updatedAt: args.now,
    })
    .where(
      and(
        eq(findingDisclosure.findingId, args.findingId),
        eq(findingDisclosure.ghsaReservationToken, args.reservationToken),
      ),
    )
    .returning({ findingId: findingDisclosure.findingId });
  return updated.length > 0;
}

export async function recordFindingDisclosureGhsaDraft(args: {
  findingId: string;
  reservationToken: string;
  ghsaId: string;
  cveId: string | null;
  ghsaHtmlUrl: string | null;
  now: Date;
}): Promise<boolean> {
  const updated = await db
    .update(findingDisclosure)
    .set({
      ghsaId: args.ghsaId,
      cveId: args.cveId,
      ghsaHtmlUrl: args.ghsaHtmlUrl,
      updatedAt: args.now,
    })
    .where(
      and(
        eq(findingDisclosure.findingId, args.findingId),
        eq(findingDisclosure.ghsaReservationToken, args.reservationToken),
      ),
    )
    .returning({ findingId: findingDisclosure.findingId });
  return updated.length > 0;
}

export async function releaseFindingDisclosureGhsaReservation(args: {
  findingId: string;
  reservationToken: string;
  now: Date;
}): Promise<void> {
  await db
    .update(findingDisclosure)
    .set({
      ghsaReservationToken: null,
      updatedAt: args.now,
    })
    .where(
      and(
        eq(findingDisclosure.findingId, args.findingId),
        eq(findingDisclosure.ghsaReservationToken, args.reservationToken),
      ),
    );
}

export async function markFindingDisclosureGhsaPublished(args: {
  findingId: string;
  ghsaHtmlUrl: string;
  ghsaPublishedAt: Date;
}): Promise<void> {
  await db
    .update(findingDisclosure)
    .set({
      ghsaHtmlUrl: args.ghsaHtmlUrl,
      ghsaPublishedAt: args.ghsaPublishedAt,
      updatedAt: args.ghsaPublishedAt,
    })
    .where(eq(findingDisclosure.findingId, args.findingId));
}

export async function loadPrivateDisclosureFindingIndexes(reviewId: string): Promise<number[]> {
  const rows = await db
    .select({ findingIndex: findingStatus.findingIndex })
    .from(findingStatus)
    .innerJoin(reviews, eq(reviews.reviewId, findingStatus.reviewId))
    .leftJoin(findingDisclosure, eq(findingDisclosure.findingId, findingStatus.findingId))
    .where(
      and(
        eq(findingStatus.reviewId, reviewId),
        or(
          isNull(findingDisclosure.findingId),
          sql`NOT (
            (
                ${findingDisclosure.state} = 'published'
                AND (
                  (
                    ${findingDisclosure.ghsaId} IS NULL
                    AND ${findingStatus.closureCommentUrl} IS NOT NULL
                  )
                  OR (
                    ${findingDisclosure.ghsaId} IS NOT NULL
                    AND ${findingDisclosure.ghsaPublishedAt} IS NOT NULL
                    AND ${findingDisclosure.ghsaHtmlUrl} IS NOT NULL
                  )
                )
              )
            OR (
              ${findingDisclosure.state} = 'none'
              AND ${reviews.publicReceipt} = true
            )
          )`,
        ),
      ),
    )
    .orderBy(findingStatus.findingIndex);
  return rows.map((row) => row.findingIndex);
}

export async function transitionFindingDisclosure(args: {
  findingId: string;
  toState: DisclosureState;
  actorType: DisclosureActorType;
  actorId: string | null;
  reason: string;
  atSha: string;
  now: Date;
  metadata?: unknown;
  acknowledgedBy?: string | null;
  forcedBy?: string | null;
  advisoryDraft?: string | null;
}): Promise<{ transitioned: boolean; fromState: DisclosureState | null }> {
  return await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        state: findingDisclosure.state,
      })
      .from(findingDisclosure)
      .where(eq(findingDisclosure.findingId, args.findingId))
      .limit(1);
    const current = rows[0]?.state as DisclosureState | undefined;
    if (current === undefined) return { transitioned: false, fromState: null };

    const sameState = current === args.toState;
    if (!sameState && !isAllowedDisclosureTransition(current, args.toState, args.actorType)) {
      throw new Error(`invalid disclosure transition ${current} -> ${args.toState}`);
    }

    const patch = {
      updatedAt: args.now,
      ...(sameState ? {} : { state: args.toState, enteredAt: args.now }),
      ...(args.acknowledgedBy !== undefined
        ? { acknowledgedAt: args.now, acknowledgedBy: args.acknowledgedBy }
        : {}),
      ...(args.forcedBy !== undefined ? { forcedBy: args.forcedBy } : {}),
      ...(args.advisoryDraft !== undefined
        ? { advisoryDraft: args.advisoryDraft, advisoryDraftUpdatedAt: args.now }
        : {}),
    };
    const updated = await tx
      .update(findingDisclosure)
      .set(patch)
      .where(
        and(eq(findingDisclosure.findingId, args.findingId), eq(findingDisclosure.state, current)),
      )
      .returning({ findingId: findingDisclosure.findingId });
    if (updated.length === 0) return { transitioned: false, fromState: current };

    const logValues: NewFindingDisclosureLog = {
      findingId: args.findingId,
      fromState: current,
      toState: args.toState,
      actorType: args.actorType,
      actorId: args.actorId,
      reason: args.reason,
      atSha: args.atSha,
      metadata: args.metadata ?? {},
    };
    await tx.insert(findingDisclosureLog).values(logValues);
    return { transitioned: !sameState, fromState: current };
  });
}

function isAllowedDisclosureTransition(
  from: DisclosureState,
  to: DisclosureState,
  actorType: DisclosureActorType,
): boolean {
  if (actorType === "operator" && to === "published") {
    return from !== "none" && from !== "published";
  }
  const allowed: Record<DisclosureState, readonly DisclosureState[]> = {
    none: [],
    embargoed: ["maintainer-acknowledged", "patch-merged", "embargo-expired"],
    "maintainer-acknowledged": ["patch-merged", "embargo-expired"],
    "patch-merged": ["embargo-expired"],
    "embargo-expired": ["published"],
    published: [],
  };
  return allowed[from].includes(to);
}

export type DisclosureFindingDetail = {
  findingId: string;
  findingIndex: number;
  title: string;
  severity: string;
  category: string;
  status: string;
  closureDetectedAt: Date | null;
  closureSha: string | null;
  patchAcceptedAt: Date | null;
  patchAcceptedSha: string | null;
  reviewId: string;
  owner: string | null;
  repo: string | null;
  installationId: number | null;
  prNumber: number;
  commitSha: string;
  publicReceipt: boolean;
  agreementDecision: unknown;
  providerResponses: unknown;
  disclosure: {
    state: DisclosureState;
    enteredAt: Date;
    createdAt: Date;
    embargoExpiresAt: Date | null;
    cveId: string | null;
    cveRequestedAt: Date | null;
    ghsaId: string | null;
    ghsaHtmlUrl: string | null;
    ghsaPublishedAt: Date | null;
    acknowledgedAt: Date | null;
    acknowledgedBy: string | null;
    maintainerUrlLogId: string | null;
    advisoryDraft: string | null;
  } | null;
  evidenceBundle: {
    affectedSha: string;
    pocSnippet: unknown;
    reproductionCommand: unknown;
    callPathTrace: unknown;
    bundleStatus: string;
  } | null;
  threatModel: unknown;
};

export async function loadDisclosureFindingDetail(
  findingId: string,
): Promise<DisclosureFindingDetail | null> {
  const rows = await db
    .select({
      findingId: findingStatus.findingId,
      findingIndex: findingStatus.findingIndex,
      title: findingStatus.title,
      severity: findingStatus.severity,
      category: findingStatus.category,
      status: findingStatus.status,
      closureDetectedAt: findingStatus.closureDetectedAt,
      closureSha: findingStatus.closureSha,
      patchAcceptedAt: findingStatus.patchAcceptedAt,
      patchAcceptedSha: findingStatus.patchAcceptedSha,
      reviewId: reviews.reviewId,
      owner: reviews.owner,
      repo: reviews.repo,
      installationId: reviews.installationId,
      prNumber: reviews.prNumber,
      commitSha: reviews.commitSha,
      publicReceipt: reviews.publicReceipt,
      agreementDecision: reviews.agreementDecision,
      providerResponses: reviews.providerResponses,
      disclosureState: findingDisclosure.state,
      enteredAt: findingDisclosure.enteredAt,
      disclosureCreatedAt: findingDisclosure.createdAt,
      embargoExpiresAt: findingDisclosure.embargoExpiresAt,
      cveId: findingDisclosure.cveId,
      cveRequestedAt: findingDisclosure.cveRequestedAt,
      ghsaId: findingDisclosure.ghsaId,
      ghsaHtmlUrl: findingDisclosure.ghsaHtmlUrl,
      ghsaPublishedAt: findingDisclosure.ghsaPublishedAt,
      acknowledgedAt: findingDisclosure.acknowledgedAt,
      acknowledgedBy: findingDisclosure.acknowledgedBy,
      maintainerUrlLogId: findingDisclosure.maintainerUrlLogId,
      advisoryDraft: findingDisclosure.advisoryDraft,
      evidenceAffectedSha: findingValidationEvidenceBundles.affectedSha,
      pocSnippet: findingValidationEvidenceBundles.pocSnippet,
      reproductionCommand: findingValidationEvidenceBundles.reproductionCommand,
      callPathTrace: findingValidationEvidenceBundles.callPathTrace,
      bundleStatus: findingValidationEvidenceBundles.bundleStatus,
      threatModel: repoThreatModel.publicModel,
    })
    .from(findingStatus)
    .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
    .leftJoin(findingDisclosure, eq(findingDisclosure.findingId, findingStatus.findingId))
    .leftJoin(
      findingValidationEvidenceBundles,
      and(
        eq(findingValidationEvidenceBundles.reviewId, findingStatus.reviewId),
        eq(findingValidationEvidenceBundles.findingId, findingStatus.findingId),
      ),
    )
    .leftJoin(repoThreatModel, eq(repoThreatModel.repoHash, reviews.repoHash))
    .where(eq(findingStatus.findingId, findingId))
    .orderBy(desc(findingValidationEvidenceBundles.reviewAttempt))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    findingId: row.findingId,
    findingIndex: row.findingIndex,
    title: row.title,
    severity: row.severity,
    category: row.category,
    status: row.status,
    closureDetectedAt: row.closureDetectedAt,
    closureSha: row.closureSha,
    patchAcceptedAt: row.patchAcceptedAt,
    patchAcceptedSha: row.patchAcceptedSha,
    reviewId: row.reviewId,
    owner: row.owner,
    repo: row.repo,
    installationId: row.installationId,
    prNumber: row.prNumber,
    commitSha: row.commitSha,
    publicReceipt: row.publicReceipt,
    agreementDecision: row.agreementDecision,
    providerResponses: row.providerResponses,
    disclosure:
      row.disclosureState === null
        ? null
        : {
            state: row.disclosureState as DisclosureState,
            enteredAt: row.enteredAt!,
            createdAt: row.disclosureCreatedAt!,
            embargoExpiresAt: row.embargoExpiresAt,
            cveId: row.cveId,
            cveRequestedAt: row.cveRequestedAt,
            ghsaId: row.ghsaId,
            ghsaHtmlUrl: row.ghsaHtmlUrl,
            ghsaPublishedAt: row.ghsaPublishedAt,
            acknowledgedAt: row.acknowledgedAt,
            acknowledgedBy: row.acknowledgedBy,
            maintainerUrlLogId: row.maintainerUrlLogId,
            advisoryDraft: row.advisoryDraft,
          },
    evidenceBundle:
      row.evidenceAffectedSha === null
        ? null
        : {
            affectedSha: row.evidenceAffectedSha,
            pocSnippet: row.pocSnippet,
            reproductionCommand: row.reproductionCommand,
            callPathTrace: row.callPathTrace,
            bundleStatus: row.bundleStatus!,
          },
    threatModel: row.threatModel,
  };
}

export async function loadDisclosureMaintainerSecret(findingId: string): Promise<{
  maintainerUrlCiphertext: string;
  maintainerUrlLogId: string;
  state: DisclosureState;
  commitSha: string;
} | null> {
  const rows = await db
    .select({
      maintainerUrlCiphertext: findingDisclosure.maintainerUrlCiphertext,
      maintainerUrlLogId: findingDisclosure.maintainerUrlLogId,
      state: findingDisclosure.state,
      commitSha: reviews.commitSha,
    })
    .from(findingDisclosure)
    .innerJoin(findingStatus, eq(findingStatus.findingId, findingDisclosure.findingId))
    .innerJoin(reviews, eq(reviews.reviewId, findingStatus.reviewId))
    .where(eq(findingDisclosure.findingId, findingId))
    .limit(1);
  const row = rows[0];
  if (
    row === undefined ||
    row.maintainerUrlCiphertext === null ||
    row.maintainerUrlLogId === null
  ) {
    return null;
  }
  return {
    maintainerUrlCiphertext: row.maintainerUrlCiphertext,
    maintainerUrlLogId: row.maintainerUrlLogId,
    state: row.state as DisclosureState,
    commitSha: row.commitSha,
  };
}

export async function loadDisclosureTimerCandidates(now: Date): Promise<DisclosureFindingDetail[]> {
  const rows = await db
    .select({ findingId: findingDisclosure.findingId })
    .from(findingDisclosure)
    .innerJoin(findingStatus, eq(findingStatus.findingId, findingDisclosure.findingId))
    .where(
      and(
        inArray(findingDisclosure.state, ["embargoed", "maintainer-acknowledged", "patch-merged"]),
        or(
          lte(findingDisclosure.embargoExpiresAt, now),
          and(
            isNotNull(findingDisclosure.acknowledgedAt),
            or(
              isNotNull(findingStatus.patchAcceptedAt),
              isNotNull(findingStatus.closureDetectedAt),
            ),
          ),
        ),
      ),
    )
    .limit(100);
  const details = await Promise.all(rows.map((row) => loadDisclosureFindingDetail(row.findingId)));
  return details.filter((row): row is DisclosureFindingDetail => row !== null);
}

export async function loadDisclosurePublishCandidates(): Promise<DisclosureFindingDetail[]> {
  const rows = await db
    .select({ findingId: findingDisclosure.findingId })
    .from(findingDisclosure)
    .where(
      or(
        eq(findingDisclosure.state, "embargo-expired"),
        and(
          eq(findingDisclosure.state, "published"),
          isNotNull(findingDisclosure.ghsaId),
          isNull(findingDisclosure.ghsaPublishedAt),
        ),
      ),
    )
    .limit(50);
  const details = await Promise.all(rows.map((row) => loadDisclosureFindingDetail(row.findingId)));
  return details.filter((row): row is DisclosureFindingDetail => row !== null);
}

export type EvidenceBundleSlotProvenance = {
  producedBy: "reviewer_consensus" | "patch_verifier" | "reachability_gate";
  sourceGateOutcomeId: string | null;
  modelId: string | null;
  reviewedSha: string;
  producedAt: string;
  reviewAttempt: number;
};

export type EvidenceBundleSlot = {
  value: unknown;
  provenance: EvidenceBundleSlotProvenance;
};

export type EvidenceBundleStatus = "complete" | "partial" | "empty";

export type RecordFindingEvidenceBundleSlotInput = {
  reviewId: string;
  findingId: string;
  reviewAttempt: number;
  affectedSha: string;
  pocSnippet?: EvidenceBundleSlot | null;
  reproductionCommand?: EvidenceBundleSlot | null;
  callPathTrace?: EvidenceBundleSlot | null;
};

function localBundleStatus(args: {
  pocSnippet?: EvidenceBundleSlot | null;
  reproductionCommand?: EvidenceBundleSlot | null;
  callPathTrace?: EvidenceBundleSlot | null;
}): EvidenceBundleStatus {
  const countPresent = [
    args.pocSnippet ?? null,
    args.reproductionCommand ?? null,
    args.callPathTrace ?? null,
  ].filter((v) => v !== null).length;
  if (countPresent === 3) return "complete";
  if (countPresent === 0) return "empty";
  return "partial";
}

const bundleStatusSql = sql<EvidenceBundleStatus>`CASE
  WHEN (
    (CASE WHEN COALESCE(excluded.poc_snippet, ${findingValidationEvidenceBundles.pocSnippet}) IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN COALESCE(excluded.reproduction_command, ${findingValidationEvidenceBundles.reproductionCommand}) IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN COALESCE(excluded.call_path_trace, ${findingValidationEvidenceBundles.callPathTrace}) IS NOT NULL THEN 1 ELSE 0 END)
  ) = 3 THEN 'complete'
  WHEN (
    (CASE WHEN COALESCE(excluded.poc_snippet, ${findingValidationEvidenceBundles.pocSnippet}) IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN COALESCE(excluded.reproduction_command, ${findingValidationEvidenceBundles.reproductionCommand}) IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN COALESCE(excluded.call_path_trace, ${findingValidationEvidenceBundles.callPathTrace}) IS NOT NULL THEN 1 ELSE 0 END)
  ) = 0 THEN 'empty'
  ELSE 'partial'
END`;

export async function recordFindingEvidenceBundleSlot(
  input: RecordFindingEvidenceBundleSlotInput,
): Promise<void> {
  const values: NewFindingValidationEvidenceBundle = {
    reviewId: input.reviewId,
    findingId: input.findingId,
    reviewAttempt: input.reviewAttempt,
    affectedSha: input.affectedSha,
    pocSnippet: input.pocSnippet ?? null,
    reproductionCommand: input.reproductionCommand ?? null,
    callPathTrace: input.callPathTrace ?? null,
    bundleStatus: localBundleStatus(input),
  };

  await db
    .insert(findingValidationEvidenceBundles)
    .values(values)
    .onConflictDoUpdate({
      target: [
        findingValidationEvidenceBundles.reviewId,
        findingValidationEvidenceBundles.findingId,
        findingValidationEvidenceBundles.reviewAttempt,
      ],
      set: {
        affectedSha: sql`excluded.affected_sha`,
        pocSnippet: sql`COALESCE(excluded.poc_snippet, ${findingValidationEvidenceBundles.pocSnippet})`,
        reproductionCommand: sql`COALESCE(excluded.reproduction_command, ${findingValidationEvidenceBundles.reproductionCommand})`,
        callPathTrace: sql`COALESCE(excluded.call_path_trace, ${findingValidationEvidenceBundles.callPathTrace})`,
        bundleStatus: bundleStatusSql,
        updatedAt: sql`now()`,
      },
    });
}

export type PublicFindingEvidenceBundleRow = Pick<
  FindingValidationEvidenceBundle,
  | "findingId"
  | "reviewId"
  | "reviewAttempt"
  | "affectedSha"
  | "pocSnippet"
  | "reproductionCommand"
  | "callPathTrace"
  | "bundleStatus"
  | "createdAt"
  | "updatedAt"
>;

export const loadPublicFindingEvidenceBundle = cache(
  async (findingId: string): Promise<PublicFindingEvidenceBundleRow | null> => {
    const disclosureGateEnabled = isDisclosureGateEnabled();
    // Cyber-tier exclusion is layered with the existing visibility gate.
    // The render layer (FindingValidationBundleSection / agent page) ALSO
    // redacts PoC + repro + trace for cyber-tier findings — defense in
    // depth so the bundle row never reaches the page even if the render
    // redaction has a bug. See lib/cyber-tier.ts.
    const visibilityCondition = and(
      disclosureGateEnabled ? derivedPublicReceiptCondition : eq(reviews.publicReceipt, true),
      nonCyberTierRepoCondition(),
    );
    const selectColumns = {
      findingId: findingValidationEvidenceBundles.findingId,
      reviewId: findingValidationEvidenceBundles.reviewId,
      reviewAttempt: findingValidationEvidenceBundles.reviewAttempt,
      affectedSha: findingValidationEvidenceBundles.affectedSha,
      pocSnippet: findingValidationEvidenceBundles.pocSnippet,
      reproductionCommand: findingValidationEvidenceBundles.reproductionCommand,
      callPathTrace: findingValidationEvidenceBundles.callPathTrace,
      bundleStatus: findingValidationEvidenceBundles.bundleStatus,
      createdAt: findingValidationEvidenceBundles.createdAt,
      updatedAt: findingValidationEvidenceBundles.updatedAt,
    };
    const rows = await (disclosureGateEnabled
      ? db
          .select(selectColumns)
          .from(findingValidationEvidenceBundles)
          .innerJoin(
            findingStatus,
            and(
              eq(findingStatus.findingId, findingValidationEvidenceBundles.findingId),
              eq(findingStatus.reviewId, findingValidationEvidenceBundles.reviewId),
            ),
          )
          .innerJoin(reviews, eq(reviews.reviewId, findingValidationEvidenceBundles.reviewId))
          .leftJoin(findingDisclosure, eq(findingDisclosure.findingId, findingStatus.findingId))
          .where(
            and(
              eq(findingValidationEvidenceBundles.findingId, findingId),
              visibilityCondition,
              eq(findingStatus.status, "closed"),
              isNotNull(findingStatus.closureDetectedAt),
              isNull(findingStatus.retractedAt),
            ),
          )
          .orderBy(
            desc(findingValidationEvidenceBundles.reviewAttempt),
            desc(findingValidationEvidenceBundles.updatedAt),
          )
          .limit(1)
      : db
          .select(selectColumns)
          .from(findingValidationEvidenceBundles)
          .innerJoin(
            findingStatus,
            and(
              eq(findingStatus.findingId, findingValidationEvidenceBundles.findingId),
              eq(findingStatus.reviewId, findingValidationEvidenceBundles.reviewId),
            ),
          )
          .innerJoin(reviews, eq(reviews.reviewId, findingValidationEvidenceBundles.reviewId))
          .where(
            and(
              eq(findingValidationEvidenceBundles.findingId, findingId),
              visibilityCondition,
              eq(findingStatus.status, "closed"),
              isNotNull(findingStatus.closureDetectedAt),
              isNull(findingStatus.retractedAt),
            ),
          )
          .orderBy(
            desc(findingValidationEvidenceBundles.reviewAttempt),
            desc(findingValidationEvidenceBundles.updatedAt),
          )
          .limit(1));

    return rows[0] ?? null;
  },
);

export type PublicSarifFindingExportRow = {
  findingId: string;
  title: string;
  severity: string;
  category: string;
  status: string;
  closureSha: string | null;
  patchAcceptedSha: string | null;
  reviewId: string;
  owner: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  evidenceBundle: {
    affectedSha: string;
    pocSnippet: unknown;
    reproductionCommand: unknown;
    callPathTrace: unknown;
    bundleStatus: string;
  } | null;
};

export const SARIF_EXPORT_TERMINAL_DISCLOSURE_STATES = ["published"] as const;

// Finding-disclosure states that count as "no embargo required" for SARIF
// export when the install is NOT a live protocol. Bench repos and other
// non-live-protocol installs never go through the disclosure flow — their
// public_receipt boolean IS the disclosure event — so historic rows have
// state='none' (from the 2026-06-23 backfill) and should still be exportable.
// Live-protocol findings stay strictly gated on a terminal disclosure state.
export const SARIF_EXPORT_NON_LIVE_PROTOCOL_PRE_DISCLOSURE_STATES = ["none"] as const;

export function isPublicSarifExportEligible(row: {
  status: string;
  closureDetectedAt: Date | null;
  retractedAt: Date | null;
  disclosureState: string | null;
  isLiveProtocol: boolean;
}): boolean {
  if (row.status !== "closed" || row.closureDetectedAt === null || row.retractedAt !== null) {
    return false;
  }
  const terminal = SARIF_EXPORT_TERMINAL_DISCLOSURE_STATES.includes(
    row.disclosureState as (typeof SARIF_EXPORT_TERMINAL_DISCLOSURE_STATES)[number],
  );
  if (terminal) return true;
  if (row.isLiveProtocol) return false;
  return SARIF_EXPORT_NON_LIVE_PROTOCOL_PRE_DISCLOSURE_STATES.includes(
    row.disclosureState as (typeof SARIF_EXPORT_NON_LIVE_PROTOCOL_PRE_DISCLOSURE_STATES)[number],
  );
}

export async function loadPublicSarifFindingsForRepo(args: {
  owner: string;
  repo: string;
}): Promise<PublicSarifFindingExportRow[]> {
  const disclosureGateEnabled = isDisclosureGateEnabled();
  // Cyber-tier exclusion at the DB layer, even though the route already
  // 404s for cyber repos. Defense in depth: if a future caller forgets
  // the route-level guard, the query still returns zero rows.
  const visibilityCondition = and(
    disclosureGateEnabled ? derivedPublicReceiptCondition : eq(reviews.publicReceipt, true),
    nonCyberTierRepoCondition(),
  );
  // SARIF export eligibility:
  //   (a) finding is closed + non-retracted + has a closure timestamp, AND
  //   (b) EITHER the disclosure flow reached a terminal state ('published'),
  //       OR the install is NOT a live protocol AND the row is in a
  //       pre-disclosure state ('none'). Live-protocol findings remain
  //       strictly gated — embargoed leaks were the H1 audit blocker.
  const disclosureTerminalCondition = inArray(
    findingDisclosure.state,
    SARIF_EXPORT_TERMINAL_DISCLOSURE_STATES,
  );
  const nonLiveProtocolPreDisclosureCondition = and(
    eq(installations.isLiveProtocol, false),
    inArray(findingDisclosure.state, SARIF_EXPORT_NON_LIVE_PROTOCOL_PRE_DISCLOSURE_STATES),
  );
  const sarifExportEligibilityCondition = and(
    eq(findingStatus.status, "closed"),
    isNotNull(findingStatus.closureDetectedAt),
    isNull(findingStatus.retractedAt),
    or(disclosureTerminalCondition, nonLiveProtocolPreDisclosureCondition),
  );
  const selectColumns = {
    findingId: findingStatus.findingId,
    title: findingStatus.title,
    severity: findingStatus.severity,
    category: findingStatus.category,
    status: findingStatus.status,
    closureSha: findingStatus.closureSha,
    patchAcceptedSha: findingStatus.patchAcceptedSha,
    reviewId: reviews.reviewId,
    owner: reviews.owner,
    repo: reviews.repo,
    prNumber: reviews.prNumber,
    commitSha: reviews.commitSha,
    evidenceAffectedSha: findingValidationEvidenceBundles.affectedSha,
    pocSnippet: findingValidationEvidenceBundles.pocSnippet,
    reproductionCommand: findingValidationEvidenceBundles.reproductionCommand,
    callPathTrace: findingValidationEvidenceBundles.callPathTrace,
    bundleStatus: findingValidationEvidenceBundles.bundleStatus,
  };

  const rows = await (disclosureGateEnabled
    ? db
        .select(selectColumns)
        .from(findingStatus)
        .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
        .leftJoin(findingDisclosure, eq(findingDisclosure.findingId, findingStatus.findingId))
        .leftJoin(
          installations,
          and(
            eq(installations.installationId, reviews.installationId),
            eq(installations.owner, reviews.owner),
            eq(installations.repo, reviews.repo),
          ),
        )
        .leftJoin(
          findingValidationEvidenceBundles,
          and(
            eq(findingValidationEvidenceBundles.reviewId, findingStatus.reviewId),
            eq(findingValidationEvidenceBundles.findingId, findingStatus.findingId),
          ),
        )
        .where(
          and(
            eq(reviews.owner, args.owner),
            eq(reviews.repo, args.repo),
            visibilityCondition,
            sarifExportEligibilityCondition,
          ),
        )
        .orderBy(desc(findingStatus.createdAt))
    : db
        .select(selectColumns)
        .from(findingStatus)
        .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
        .leftJoin(findingDisclosure, eq(findingDisclosure.findingId, findingStatus.findingId))
        .leftJoin(
          installations,
          and(
            eq(installations.installationId, reviews.installationId),
            eq(installations.owner, reviews.owner),
            eq(installations.repo, reviews.repo),
          ),
        )
        .leftJoin(
          findingValidationEvidenceBundles,
          and(
            eq(findingValidationEvidenceBundles.reviewId, findingStatus.reviewId),
            eq(findingValidationEvidenceBundles.findingId, findingStatus.findingId),
          ),
        )
        .where(
          and(
            eq(reviews.owner, args.owner),
            eq(reviews.repo, args.repo),
            visibilityCondition,
            sarifExportEligibilityCondition,
          ),
        )
        .orderBy(desc(findingStatus.createdAt)));

  return rows
    .filter((row) => row.owner !== null && row.repo !== null)
    .map((row) => ({
      findingId: row.findingId,
      title: row.title,
      severity: row.severity,
      category: row.category,
      status: row.status,
      closureSha: row.closureSha,
      patchAcceptedSha: row.patchAcceptedSha,
      reviewId: row.reviewId,
      owner: row.owner!,
      repo: row.repo!,
      prNumber: row.prNumber,
      commitSha: row.commitSha,
      evidenceBundle:
        row.evidenceAffectedSha === null
          ? null
          : {
              affectedSha: row.evidenceAffectedSha,
              pocSnippet: row.pocSnippet,
              reproductionCommand: row.reproductionCommand,
              callPathTrace: row.callPathTrace,
              bundleStatus: row.bundleStatus!,
            },
    }));
}
