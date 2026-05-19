import { createHash } from "node:crypto";
import { and, count, desc, eq, gte, isNotNull, lt, lte, max, ne, or, sql } from "drizzle-orm";
import { db } from "./index";
import {
  agentFindings,
  findingStatus,
  maintainerReactions,
  onboardingEvents,
  roastSubmissions,
  outgoingPrs,
  reviews,
  type AgentFinding,
  type NewAgentFinding,
  type NewMaintainerReaction,
  type NewOnboardingEvent,
  type NewReview,
  type OnboardingEvent,
  type RoastSubmission,
} from "./schema";
import { writePostDraft } from "@/lib/post-drafts";

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
// ["pending", "pending_retry", "in_progress"] (the last only when the row
// looks stuck; cron applies an age filter on processingStartedAt itself).
// Returns true iff the row transitioned to in_progress. False means another
// worker beat us to it — caller should move on without processing.
export async function claimReviewForProcessing(args: {
  reviewId: string;
  fromStatuses: ReadonlyArray<ReviewProcessingStatus>;
  now: Date;
}): Promise<boolean> {
  if (args.fromStatuses.length === 0) return false;
  // `sql.raw` would invite injection; build the IN list with placeholders.
  const placeholders = sql.join(
    args.fromStatuses.map((s) => sql`${s}`),
    sql`, `,
  );
  const result = await db.execute(sql`
    UPDATE ${reviews}
    SET
      ${reviews.processingStatus} = 'in_progress',
      ${reviews.processingStartedAt} = ${args.now},
      ${reviews.processingAttempts} = ${reviews.processingAttempts} + 1,
      ${reviews.nextRetryAt} = NULL
    WHERE ${reviews.reviewId} = ${args.reviewId}
      AND ${reviews.processingStatus} IN (${placeholders})
  `);
  // neon-http exposes rowCount on the result object.
  const rowCount = (result as { rowCount?: number | null }).rowCount ?? 0;
  return rowCount > 0;
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
export type RetryCandidate = {
  reviewId: string;
  processingStatus: string;
  processingAttempts: number;
};

export async function loadReviewsReadyForRetry(args: {
  now: Date;
  stuckBefore: Date;
  limit: number;
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
          eq(reviews.processingStatus, "pending"),
          and(eq(reviews.processingStatus, "pending_retry"), lte(reviews.nextRetryAt, args.now)),
          and(
            eq(reviews.processingStatus, "in_progress"),
            lt(reviews.processingStartedAt, args.stuckBefore),
          ),
        ),
      ),
    )
    .orderBy(reviews.createdAt)
    .limit(args.limit);
  return rows;
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

/** Stable id format: `<first-8-of-reviewId>-<findingIndex>`. */
export function makeFindingId(reviewId: string, findingIndex: number): string {
  return `${reviewId.slice(0, 8)}-${findingIndex}`;
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
  category: string;
};

export async function recordFindingStatuses(
  reviewId: string,
  agreed: FindingLifecycleInput[],
): Promise<string[]> {
  if (agreed.length === 0) return [];
  const rows = agreed.map((f, index) => ({
    reviewId,
    findingIndex: index,
    findingId: makeFindingId(reviewId, index),
    title: f.title,
    severity: f.severity,
    category: f.category,
  }));
  const inserted = await db.insert(findingStatus).values(rows).returning({
    findingId: findingStatus.findingId,
  });
  return inserted.map((r) => r.findingId);
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
      findingCreatedAt: findingStatus.createdAt,
      findingLastPolledAt: findingStatus.lastPolledAt,
    })
    .from(findingStatus)
    .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
    .where(eq(findingStatus.status, "open"));

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
  category: string;
  title: string;
  repoHash: string;
  prNumber: number;
  closureSha: string | null;
  closureCommentUrl: string | null;
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
  // Fetch limit+1 so we can answer hasMore without a second count query.
  const fetchLimit = args.limit + 1;
  // Gate condition is identical across all three queries — closed findings
  // attached to reviews flagged for public visibility. Inlined per-query
  // because the count and max queries need the join too.
  const recentConditions =
    args.before === undefined
      ? and(eq(findingStatus.status, "closed"), eq(reviews.publicReceipt, true))
      : and(
          eq(findingStatus.status, "closed"),
          eq(reviews.publicReceipt, true),
          lt(findingStatus.closureDetectedAt, args.before),
        );

  const totalConditions = and(eq(findingStatus.status, "closed"), eq(reviews.publicReceipt, true));

  const [countRows, fetchedRows, lastUpdatedRows] = await Promise.all([
    db
      .select({ value: count() })
      .from(findingStatus)
      .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
      .where(totalConditions),
    db
      .select({
        findingId: findingStatus.findingId,
        severity: findingStatus.severity,
        category: findingStatus.category,
        title: findingStatus.title,
        repoHash: reviews.repoHash,
        prNumber: reviews.prNumber,
        closureSha: findingStatus.closureSha,
        closureCommentUrl: findingStatus.closureCommentUrl,
        closedAt: findingStatus.closureDetectedAt,
      })
      .from(findingStatus)
      .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
      .where(recentConditions)
      .orderBy(desc(findingStatus.closureDetectedAt))
      .limit(fetchLimit),
    db
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

// Mission Phase-2 P2-E — single-receipt detail page. Returns the full
// receipt context for one finding: same column projection as
// loadPublicReceiptsPage plus the JSONB that carries the per-provider
// reasoning + the agreement decision shape. The page consumes both. Same
// public_receipt = true gate as the list query — no public receipt = 404.
export type PublicReceiptDetailRow = PublicReceiptRow & {
  reviewId: string;
  findingIndex: number;
  prCommentUrl: string | null;
  reviewCreatedAt: Date;
  timingMs: number;
  costEstimatedUsd: string;
  providerModelIds: unknown;
  providerResponses: unknown;
  agreementDecision: unknown;
};

export async function loadPublicReceiptDetail(
  findingId: string,
): Promise<PublicReceiptDetailRow | null> {
  const rows = await db
    .select({
      findingId: findingStatus.findingId,
      findingIndex: findingStatus.findingIndex,
      severity: findingStatus.severity,
      category: findingStatus.category,
      title: findingStatus.title,
      closureSha: findingStatus.closureSha,
      closureCommentUrl: findingStatus.closureCommentUrl,
      closedAt: findingStatus.closureDetectedAt,
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
    })
    .from(findingStatus)
    .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
    .where(and(eq(findingStatus.findingId, findingId), eq(reviews.publicReceipt, true)))
    .limit(1);

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
  | "partner_reply";

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
    db
      .select({ value: max(findingStatus.closureDetectedAt) })
      .from(findingStatus)
      .where(eq(findingStatus.status, "closed")),
    db
      .select({ value: max(onboardingEvents.createdAt) })
      .from(onboardingEvents)
      .where(eq(onboardingEvents.public, true)),
    db.select({ value: max(reviews.createdAt) }).from(reviews),
    activityWindow(since24h),
    activityWindow(since7d),
    activityWindow(null),
    db
      .select({
        ts: reviews.createdAt,
        repoHash: reviews.repoHash,
        prNumber: reviews.prNumber,
        owner: reviews.owner,
        repo: reviews.repo,
      })
      .from(reviews)
      // Left join so zero-finding reviews surface (the aggregate reviewsRun
      // counter already counts them; the stream should match).
      .leftJoin(findingStatus, eq(reviews.reviewId, findingStatus.reviewId))
      .where(eq(reviews.publicReceipt, true))
      .orderBy(desc(reviews.createdAt))
      .limit(EVENT_STREAM_LIMIT),
    db
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
      .where(eq(reviews.publicReceipt, true))
      .orderBy(desc(findingStatus.createdAt))
      .limit(EVENT_STREAM_LIMIT),
    db
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
      .where(and(eq(findingStatus.status, "closed"), eq(reviews.publicReceipt, true)))
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

async function activityWindow(sinceDate: Date | null): Promise<ActivityWindow> {
  const reviewsWhere = sinceDate === null ? undefined : gte(reviews.createdAt, sinceDate);
  const findingsCreatedWhere =
    sinceDate === null ? undefined : gte(findingStatus.createdAt, sinceDate);
  const findingsClosedWhere =
    sinceDate === null
      ? eq(findingStatus.status, "closed")
      : and(eq(findingStatus.status, "closed"), gte(findingStatus.closureDetectedAt, sinceDate));
  const reactionsWhere =
    sinceDate === null ? undefined : gte(maintainerReactions.polledAt, sinceDate);

  const reviewsCountQuery =
    reviewsWhere === undefined
      ? db.select({ value: count() }).from(reviews)
      : db.select({ value: count() }).from(reviews).where(reviewsWhere);

  const agreedCountQuery =
    findingsCreatedWhere === undefined
      ? db.select({ value: count() }).from(findingStatus)
      : db.select({ value: count() }).from(findingStatus).where(findingsCreatedWhere);

  const closedCountQuery = db
    .select({ value: count() })
    .from(findingStatus)
    .where(findingsClosedWhere);

  const reactionsCountQuery =
    reactionsWhere === undefined
      ? db.select({ value: count() }).from(maintainerReactions)
      : db.select({ value: count() }).from(maintainerReactions).where(reactionsWhere);

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
  const inserted = await db
    .insert(maintainerReactions)
    .values(rows)
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
  const baseConditions = and(eq(reviews.isBenchmark, true), eq(reviews.publicReceipt, true));
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
// reviews tied to the agent's repo (cross-reference by repo name pattern
// `agent-<name>-bench`) and any merged upstream PRs AntFleet opened
// against the agent's own repo (cross-reference by upstream_repo = agent_name).
// The address is matched case-insensitively because users will paste mixed-
// case checksummed addresses from explorers.
export type AgentDetail = {
  agentTokenAddress: string;
  agentName: string;
  findings: AgentFinding[];
  benchmarkReviews: AgentBenchmarkReference[];
  crossRepoMerges: AgentCrossRepoMerge[];
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
  mergedAt: Date;
  mergeSha: string;
  prUrl: string;
};

export async function loadAgentDetail(address: string): Promise<AgentDetail | null> {
  const normalized = address.toLowerCase();
  const findings = await db
    .select()
    .from(agentFindings)
    .where(sql`lower(${agentFindings.agentTokenAddress}) = ${normalized}`)
    .orderBy(desc(agentFindings.publishedAt));

  if (findings.length === 0) return null;

  const first = findings[0]!;
  const benchRepoPattern = `agent-${first.agentName.replace(/^agent-/, "")}-bench`;

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
          eq(reviews.publicReceipt, true),
          sql`lower(${reviews.repo}) = ${benchRepoPattern.toLowerCase()}`,
        ),
      )
      .orderBy(desc(reviews.createdAt)),
    // Merged upstream PRs AntFleet opened against this agent's own repo
    // (not the -bench fork). The /receipts page already surfaces these
    // globally; here we just slice them by the upstream_repo matching the
    // agent name, so the agent page becomes the per-agent attribution view.
    db
      .select({
        id: outgoingPrs.id,
        upstreamOwner: outgoingPrs.upstreamOwner,
        upstreamRepo: outgoingPrs.upstreamRepo,
        upstreamPrNumber: outgoingPrs.upstreamPrNumber,
        mergedAt: outgoingPrs.mergedAt,
        mergeSha: outgoingPrs.mergeSha,
      })
      .from(outgoingPrs)
      .where(
        and(
          eq(outgoingPrs.status, "merged"),
          sql`lower(${outgoingPrs.upstreamRepo}) = ${first.agentName.toLowerCase()}`,
        ),
      )
      .orderBy(sql`${outgoingPrs.mergedAt} DESC NULLS LAST`),
  ]);

  const crossRepoMerges: AgentCrossRepoMerge[] = mergedOutgoingRows
    .filter((r) => r.mergedAt !== null && r.mergeSha !== null)
    .map((r) => ({
      id: r.id,
      upstreamOwner: r.upstreamOwner,
      upstreamRepo: r.upstreamRepo,
      upstreamPrNumber: r.upstreamPrNumber,
      mergedAt: r.mergedAt as Date,
      mergeSha: r.mergeSha as string,
      prUrl: `https://github.com/${r.upstreamOwner}/${r.upstreamRepo}/pull/${r.upstreamPrNumber}`,
    }));

  return {
    agentTokenAddress: first.agentTokenAddress,
    agentName: first.agentName,
    findings,
    benchmarkReviews: benchmarkRows,
    crossRepoMerges,
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
  const rows = await db
    .select({
      agentTokenAddress: agentFindings.agentTokenAddress,
      agentName: agentFindings.agentName,
      findingCount: sql<number>`count(*)::int`.as("finding_count"),
      lastFindingAt: sql<Date>`max(${agentFindings.publishedAt})`.as("last_finding_at"),
      severities: sql<string[]>`array_agg(${agentFindings.severity})`.as("severities"),
    })
    .from(agentFindings)
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
