// Finding lifecycle state — which finding_status columns mark a row as
// "already mutated by another worker" and therefore must be preserved
// when recordFindingStatuses reconciles on retry.
//
// The reconciliation path in queries.ts.recordFindingStatuses deletes
// trailing rows beyond the new agreed-length when the row is still
// "untouched". This module is the single source of truth for that
// definition, kept beside the schema declarations so that adding a new
// lifecycle column without updating the preserve predicate is a visible
// audit point.
//
// When you add a new lifecycle column to finding_status (sweeper output,
// patch lane state, retraction, etc.) decide:
//   • If the column being set implies "this row has real history" →
//     add it to LIFECYCLE_PRESERVE_COLUMNS so the reconciliation guard
//     keeps the row.
//   • If the column is purely descriptive / identity-style (title,
//     severity, category) it does NOT belong here.
//
// The helper itself is a structural record so that a future
// schema-introspection test can verify every nullable lifecycle column
// is classified.

import { and, eq, gte, isNull } from "drizzle-orm";
import { findingStatus } from "./schema";

// Each entry is a column whose non-null value signals the row should
// survive reconciliation. The current write paths:
//   closureSha            sweeper.ts (Mission 3)
//   closureCommentId      sweeper.ts
//   patchReviewCommentId  patch-review-comment.ts (Patch Agent v1.6)
//   patchAcceptedSha      sweeper.ts patch-acceptance pass
//   retractedAt           apps/web/app/api/admin/retract/[findingId]/route.ts
export const LIFECYCLE_PRESERVE_COLUMNS = [
  findingStatus.closureSha,
  findingStatus.closureCommentId,
  findingStatus.patchReviewCommentId,
  findingStatus.patchAcceptedSha,
  findingStatus.retractedAt,
] as const;

// Build the drizzle predicate the reconciliation transaction uses to
// identify trailing rows safe to delete: same reviewId, beyond the new
// agreed-length cutoff, status still 'open', and every lifecycle
// preserve column is NULL.
export function reconcilableTrailingRows(reviewId: string, agreedLength: number) {
  return and(
    eq(findingStatus.reviewId, reviewId),
    gte(findingStatus.findingIndex, agreedLength),
    eq(findingStatus.status, "open"),
    ...LIFECYCLE_PRESERVE_COLUMNS.map((c) => isNull(c)),
  );
}
