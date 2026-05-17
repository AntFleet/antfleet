import { createHash } from "node:crypto";
import { and, count, desc, eq, lt, max } from "drizzle-orm";
import { db } from "./index";
import {
  findingStatus,
  maintainerReactions,
  reviews,
  type NewMaintainerReaction,
  type NewReview,
} from "./schema";

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
  await db
    .update(findingStatus)
    .set(values)
    .where(eq(findingStatus.findingId, args.findingId));
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
      ? and(
          eq(findingStatus.status, "closed"),
          eq(reviews.publicReceipt, true),
        )
      : and(
          eq(findingStatus.status, "closed"),
          eq(reviews.publicReceipt, true),
          lt(findingStatus.closureDetectedAt, args.before),
        );

  const totalConditions = and(
    eq(findingStatus.status, "closed"),
    eq(reviews.publicReceipt, true),
  );

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
    .where(
      and(
        eq(findingStatus.findingId, findingId),
        eq(reviews.publicReceipt, true),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function recordMaintainerReactions(
  rows: NewMaintainerReaction[],
): Promise<number> {
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
