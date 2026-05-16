import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { findingStatus, reviews, type NewReview } from "./schema";

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
