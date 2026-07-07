// Finding lifecycle state — every finding_status column needed for the
// reconciliation guard lives here as one classified map. The
// reconciliation path in queries.ts.recordFindingStatuses deletes
// trailing rows beyond the new agreed-length only when the row is still
// "untouched"; this module is the single source of truth for what
// "untouched" means.
//
// When a new finding_status column is added to schema.ts:
//   • If the column being set implies "this row has real history" →
//     add it to the map below with reconciliation: "preserve" so the
//     reconciliation guard keeps the row.
//   • If the column is purely descriptive / identity-style (title,
//     severity, label, category) → reconciliation: "identity".
//   • If the column is metadata that does not affect reconciliation
//     intent (created_at, last_polled_at, patch_proposed_at,
//     suggested_patch payloads, token counts, rationales) →
//     reconciliation: "metadata".

import { and, eq, gte, isNull } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { findingStatus } from "./schema";

type ReconciliationRole = "identity" | "preserve" | "metadata";

type LifecycleClassification = {
  column: PgColumn;
  reconciliation: ReconciliationRole;
};

// Authoritative classification keyed by drizzle column reference. Order
// mirrors the schema declarations in apps/web/db/schema.ts so a future
// reader can scan top-to-bottom against the table definition.
export const FINDING_LIFECYCLE_CLASSIFICATION: ReadonlyArray<LifecycleClassification> = [
  // Identity columns — overwritten on retry from the new agreed bundle.
  { column: findingStatus.title, reconciliation: "identity" },
  { column: findingStatus.severity, reconciliation: "identity" },
  { column: findingStatus.label, reconciliation: "identity" },
  { column: findingStatus.category, reconciliation: "identity" },
  // Lifecycle status driver. Changing 'open' → 'closed' is what marks
  // a row as preserve-worthy.
  { column: findingStatus.status, reconciliation: "preserve" },
  // Sweeper closure metadata.
  { column: findingStatus.closureSha, reconciliation: "preserve" },
  { column: findingStatus.closureCommentId, reconciliation: "preserve" },
  { column: findingStatus.closureCommentUrl, reconciliation: "metadata" },
  { column: findingStatus.closureDetectedAt, reconciliation: "metadata" },
  { column: findingStatus.lastPolledAt, reconciliation: "metadata" },
  // Patch Agent v1.5 — suggested patch payloads + per-side fields are
  // descriptive metadata; the load-bearing preserve anchor is
  // patchAcceptedSha (sweeper detected the patch landed) and
  // patchReviewCommentId (v1.6 click-apply lane posted a review comment).
  { column: findingStatus.suggestedPatch, reconciliation: "metadata" },
  { column: findingStatus.patchProposedAt, reconciliation: "metadata" },
  { column: findingStatus.patchModelId, reconciliation: "metadata" },
  { column: findingStatus.patchAcceptedAt, reconciliation: "preserve" },
  { column: findingStatus.patchAcceptedSha, reconciliation: "preserve" },
  { column: findingStatus.patchSkipReason, reconciliation: "metadata" },
  // Patch Agent v1.6.
  { column: findingStatus.patchReviewCommentId, reconciliation: "preserve" },
  { column: findingStatus.patchReviewCommentUrl, reconciliation: "metadata" },
  { column: findingStatus.patchReviewProposedAt, reconciliation: "metadata" },
  { column: findingStatus.patchApplyClickedAt, reconciliation: "preserve" },
  // Eval Phase 0 dual-candidate persistence — recorded for analytics,
  // not load-bearing for reconciliation.
  { column: findingStatus.suggestedPatchOpus, reconciliation: "metadata" },
  { column: findingStatus.suggestedPatchGpt5, reconciliation: "metadata" },
  { column: findingStatus.patchShipped, reconciliation: "metadata" },
  { column: findingStatus.patchSelector, reconciliation: "metadata" },
  // Token instrumentation.
  { column: findingStatus.inputTokensOpus, reconciliation: "metadata" },
  { column: findingStatus.outputTokensOpus, reconciliation: "metadata" },
  { column: findingStatus.inputTokensGpt5, reconciliation: "metadata" },
  { column: findingStatus.outputTokensGpt5, reconciliation: "metadata" },
  // Patch rationales / per-side skip reasons.
  { column: findingStatus.patchRationaleOpus, reconciliation: "metadata" },
  { column: findingStatus.patchRationaleGpt5, reconciliation: "metadata" },
  { column: findingStatus.patchSkipReasonOpus, reconciliation: "metadata" },
  { column: findingStatus.patchSkipReasonGpt5, reconciliation: "metadata" },
  // Operator retraction surface.
  { column: findingStatus.retractedAt, reconciliation: "preserve" },
  { column: findingStatus.retractionReason, reconciliation: "metadata" },
  { column: findingStatus.retractionEmail, reconciliation: "metadata" },
];

export const LIFECYCLE_PRESERVE_COLUMNS = FINDING_LIFECYCLE_CLASSIFICATION.filter(
  (c) => c.reconciliation === "preserve" && c.column !== findingStatus.status,
).map((c) => c.column);

// Build the drizzle predicate the reconciliation transaction uses to
// identify trailing rows safe to delete: same reviewId, beyond the new
// finding-length cutoff, status still 'open', and every lifecycle
// preserve column is NULL.
//
// Win 2: scoped to a single `source` tier (default 'consensus'). Without
// this scope a consensus reconciliation with a shorter agreed[] would delete
// shadow rows (source='single_model') that share the same reviewId — their
// finding_index counts from 0 into a DIFFERENT array. Each tier reconciles
// only its own rows.
export function reconcilableTrailingRows(
  reviewId: string,
  agreedLength: number,
  source = "consensus",
) {
  return and(
    eq(findingStatus.reviewId, reviewId),
    eq(findingStatus.source, source),
    gte(findingStatus.findingIndex, agreedLength),
    eq(findingStatus.status, "open"),
    ...LIFECYCLE_PRESERVE_COLUMNS.map((c) => isNull(c)),
  );
}
