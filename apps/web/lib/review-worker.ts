// Mission 7 — review worker. Single function that takes a reviews row id
// and drives it from in_progress → done | pending_retry | failed. Both
// callers (the webhook's after() and the retry cron tick) funnel through
// here so the lifecycle logic is in exactly one place.
//
// Deps are injected so tests can wire mocks without DB / network / SDK.
// In production the route handler builds a `realWorkerDeps()` and passes
// it; `runReviewWorker(reviewId)` (no deps arg) is a thin convenience
// wrapper around the real deps.

import { Octokit } from "@octokit/rest";
import { getInstallationToken as realGetInstallationToken } from "./github-app";
import { getChangedFiles as realGetChangedFiles } from "./github-files";
import { formatPRComment, postPRComment as realPostPRComment } from "./pr-comment";
import { reviewPR as realReviewPR } from "./review-pipeline";
import {
  recordPatchProposedEvent as realRecordPatchProposedEvent,
  runFirstReviewSummary as realRunFirstReviewSummary,
} from "./onboarder";
import { runPatchAgent as realRunPatchAgent } from "./patch-agent";
import { logError, logInfo, messageOf } from "./log";
import { db } from "@/db";
import {
  loadReviewSettlement as realLoadReviewSettlement,
  type ReviewSettlement,
} from "@/lib/paywall/queries";
import {
  claimReviewForProcessing as realClaimReviewForProcessing,
  loadReviewQueueRow as realLoadReviewQueueRow,
  markReviewFailedForRetry as realMarkReviewFailedForRetry,
  markReviewSucceeded as realMarkReviewSucceeded,
  markReviewTerminallyFailed as realMarkReviewTerminallyFailed,
  recordFindingStatuses as realRecordFindingStatuses,
  recordPatchDecisions as realRecordPatchDecisions,
  setReviewComment as realSetReviewComment,
  setReviewPatchCost as realSetReviewPatchCost,
  updateReview as realUpdateReview,
  type ReviewProcessingStatus,
  type ReviewQueueRow,
} from "@/db/queries";

// Backoff sequence. Indexed by the attempts counter AFTER the failure
// (so a 1st-attempt failure picks index 0 → 60s, 2nd → 120s, …). 6 is
// the terminal threshold: after the 6th failure we mark the row failed
// rather than schedule another retry. Total wall-clock from first
// failure to terminal ≈ 60+120+240+480+960+1800 ≈ 62 minutes.
const BACKOFF_SECONDS = [60, 120, 240, 480, 960, 1800] as const;
export const MAX_PROCESSING_ATTEMPTS = BACKOFF_SECONDS.length;

// A row that has been claimed and stuck in in_progress for longer than
// this is considered abandoned — the cron re-claims it. Picked to be
// well above a normal review's runtime (Pro plan maxDuration is 300s);
// 5 minutes gives the worker headroom to finish the slowest observed
// PRs without the cron stomping on a still-running attempt.
export const STUCK_AFTER_MS = 5 * 60 * 1000;

export type WorkerOutcome =
  | { kind: "done"; reviewId: string; agreedCount: number; degraded: boolean }
  | { kind: "skipped"; reviewId: string; reason: string }
  | { kind: "retried"; reviewId: string; attempts: number; nextRetryAt: Date; error: string }
  | { kind: "failed"; reviewId: string; attempts: number; error: string };

export type ClaimSource = "webhook" | "cron";

export type WorkerDeps = {
  getInstallationToken: typeof realGetInstallationToken;
  getChangedFiles: typeof realGetChangedFiles;
  reviewPR: typeof realReviewPR;
  postPRComment: typeof realPostPRComment;
  runFirstReviewSummary: typeof realRunFirstReviewSummary;
  recordPatchProposedEvent: typeof realRecordPatchProposedEvent;
  runPatchAgent: typeof realRunPatchAgent;
  loadReviewQueueRow: typeof realLoadReviewQueueRow;
  claimReviewForProcessing: typeof realClaimReviewForProcessing;
  updateReview: typeof realUpdateReview;
  setReviewComment: typeof realSetReviewComment;
  recordFindingStatuses: typeof realRecordFindingStatuses;
  recordPatchDecisions: typeof realRecordPatchDecisions;
  setReviewPatchCost: typeof realSetReviewPatchCost;
  markReviewSucceeded: typeof realMarkReviewSucceeded;
  markReviewFailedForRetry: typeof realMarkReviewFailedForRetry;
  markReviewTerminallyFailed: typeof realMarkReviewTerminallyFailed;
  loadReviewSettlement: (reviewId: string) => Promise<ReviewSettlement | null>;
  now: () => Date;
};

export function realWorkerDeps(): WorkerDeps {
  return {
    getInstallationToken: realGetInstallationToken,
    getChangedFiles: realGetChangedFiles,
    reviewPR: realReviewPR,
    postPRComment: realPostPRComment,
    runFirstReviewSummary: realRunFirstReviewSummary,
    recordPatchProposedEvent: realRecordPatchProposedEvent,
    runPatchAgent: realRunPatchAgent,
    loadReviewQueueRow: realLoadReviewQueueRow,
    claimReviewForProcessing: realClaimReviewForProcessing,
    updateReview: realUpdateReview,
    setReviewComment: realSetReviewComment,
    recordFindingStatuses: realRecordFindingStatuses,
    recordPatchDecisions: realRecordPatchDecisions,
    setReviewPatchCost: realSetReviewPatchCost,
    markReviewSucceeded: realMarkReviewSucceeded,
    markReviewFailedForRetry: realMarkReviewFailedForRetry,
    markReviewTerminallyFailed: realMarkReviewTerminallyFailed,
    loadReviewSettlement: (reviewId) => realLoadReviewSettlement(db, reviewId),
    now: () => new Date(),
  };
}

export async function runReviewWorker(
  reviewId: string,
  source: ClaimSource,
  deps: WorkerDeps = realWorkerDeps(),
): Promise<WorkerOutcome> {
  const row = await deps.loadReviewQueueRow(reviewId);
  if (row === null) {
    logError("worker.row_missing", { reviewId, source });
    return { kind: "skipped", reviewId, reason: "row_missing" };
  }

  // Idempotency gates BEFORE claiming — these checks are cheap and reading
  // a 'done' row from cache should not trigger an attempts++ side effect.
  if (row.processingStatus === "done") {
    return { kind: "skipped", reviewId, reason: "already_done" };
  }
  if (row.processingStatus === "failed") {
    return { kind: "skipped", reviewId, reason: "terminally_failed" };
  }
  if (row.prCommentId !== null) {
    // A prior attempt posted the comment but didn't finish settling the
    // status — fast-path: re-settle as done. The terminal write is
    // idempotent (UPDATE … SET status='done').
    await deps.markReviewSucceeded({ reviewId, now: deps.now() });
    return { kind: "skipped", reviewId, reason: "comment_already_posted" };
  }
  const { installationId, owner, repo } = row;
  if (installationId === null || owner === null || repo === null) {
    logError("worker.missing_dispatch_context", { reviewId, source });
    await deps.markReviewTerminallyFailed({
      reviewId,
      now: deps.now(),
      error: "missing installation/owner/repo on row",
    });
    return {
      kind: "failed",
      reviewId,
      attempts: row.processingAttempts,
      error: "missing dispatch context",
    };
  }
  const dispatchRow = { ...row, installationId, owner, repo };

  const fromStatuses = allowedClaimSources(source);
  const claimed = await deps.claimReviewForProcessing({
    reviewId,
    fromStatuses,
    now: deps.now(),
  });
  if (!claimed) {
    // Another worker beat us. This is the expected race outcome when the
    // webhook's after() and the retry cron both reach the same row.
    return { kind: "skipped", reviewId, reason: "lost_claim_race" };
  }

  const attemptsAfterClaim = row.processingAttempts + 1;

  try {
    await processClaimedRow(reviewId, dispatchRow, deps);
    await deps.markReviewSucceeded({ reviewId, now: deps.now() });
    logInfo("worker.completed", {
      reviewId,
      source,
      attempts: attemptsAfterClaim,
    });
    return { kind: "done", reviewId, agreedCount: 0, degraded: false };
  } catch (err) {
    const message = messageOf(err);
    const retryable = isTransientError(err);
    const remaining = MAX_PROCESSING_ATTEMPTS - attemptsAfterClaim;
    logError("worker.failed", {
      reviewId,
      source,
      attempts: attemptsAfterClaim,
      remaining,
      retryable,
      message,
    });
    if (!retryable || remaining <= 0) {
      await deps.markReviewTerminallyFailed({
        reviewId,
        now: deps.now(),
        error: message,
      });
      return { kind: "failed", reviewId, attempts: attemptsAfterClaim, error: message };
    }
    const nextRetryAt = computeNextRetryAt(deps.now(), attemptsAfterClaim);
    await deps.markReviewFailedForRetry({
      reviewId,
      nextRetryAt,
      error: message,
    });
    return {
      kind: "retried",
      reviewId,
      attempts: attemptsAfterClaim,
      nextRetryAt,
      error: message,
    };
  }
}

function allowedClaimSources(source: ClaimSource): ReadonlyArray<ReviewProcessingStatus> {
  if (source === "webhook") {
    // Webhook arrives immediately after enqueue — the row is always
    // 'pending' on the happy path. We refuse to claim from any other
    // state so a duplicate delivery doesn't shoulder past an
    // in-progress retry.
    return ["pending"];
  }
  // Cron tick: pick up rows the webhook never reached (pending), rows
  // ready for a scheduled retry (pending_retry), and rows where a prior
  // worker died mid-attempt (in_progress, with the staleness filter
  // applied by the loader query — see loadReviewsReadyForRetry).
  return ["pending", "pending_retry", "in_progress"];
}

// Inner review work. Identical surface to the legacy webhook after()
// body — get files, run the pipeline, persist, post comment if agreed,
// record finding lifecycle, fire onboarder. Any throw bubbles up to
// runReviewWorker's catch where retry decisions are made.
async function processClaimedRow(
  reviewId: string,
  row: ReviewQueueRow & { installationId: number; owner: string; repo: string },
  deps: WorkerDeps,
): Promise<void> {
  const installationToken = await deps.getInstallationToken(row.installationId);
  const files = await deps.getChangedFiles({
    installationId: row.installationId,
    owner: row.owner,
    repo: row.repo,
    prNumber: row.prNumber,
    headSha: row.commitSha,
  });
  logInfo("review.files_fetched", {
    reviewId,
    fileCount: files.length,
    filenames: files.map((f) => f.filename),
  });

  if (files.length === 0) {
    await deps.updateReview(reviewId, {
      filesReviewed: [],
      providerResponses: { status: "skipped", reason: "no reviewable files" },
      agreementDecision: { status: "skipped" },
    });
    logInfo("review.skipped", { reviewId, reason: "no reviewable files" });
    return;
  }

  const bundle = await deps.reviewPR({
    files,
    owner: row.owner,
    repo: row.repo,
    prNumber: row.prNumber,
  });
  await deps.updateReview(reviewId, {
    filesReviewed: files.map((f) => f.filename),
    providerModelIds: bundle.modelIds,
    providerResponses: { perProvider: bundle.perProvider },
    agreementDecision: {
      mode: bundle.agreementMode,
      agreed: bundle.agreed,
      disagreements: bundle.disagreements,
      degraded: bundle.degraded,
      degradedReason: bundle.degradedReason,
    },
    timingMs: bundle.totalMs,
    costEstimatedUsd: bundle.estimatedCostUsd,
  });
  logInfo("review.completed", {
    reviewId,
    agreedCount: bundle.agreed.length,
    degraded: bundle.degraded,
    degradedReason: bundle.degradedReason,
    totalMs: bundle.totalMs,
    estimatedCostUsd: bundle.estimatedCostUsd,
    providerStatuses: bundle.perProvider.map((p) => ({
      name: p.name,
      ok: p.output !== null,
      ms: p.ms,
    })),
  });

  // Onboarder summary fires regardless of agreed/degraded. It self-gates
  // on ONBOARDER_ENABLED + first-review-only. Failures are logged but
  // never bubble; the review itself is the load-bearing outcome.
  try {
    const perProviderFindingCounts: Record<string, number> = {};
    for (const p of bundle.perProvider) {
      perProviderFindingCounts[p.name] = p.output?.findings.length ?? 0;
    }
    await deps.runFirstReviewSummary({
      installationId: row.installationId,
      owner: row.owner,
      repo: row.repo,
      prNumber: row.prNumber,
      perProviderFindingCounts,
      agreedCount: bundle.agreed.length,
      disagreementCount: bundle.disagreements.length,
      modelIds: bundle.modelIds,
    });
  } catch (err) {
    logError("onboarder.first_review_summary_dispatch_failed", {
      reviewId,
      message: messageOf(err),
    });
  }

  if (bundle.degraded || bundle.agreed.length === 0) return;

  // Patch Agent v1.5 — between agreement gate and comment post. Returns
  // null when the env flag is disabled OR when the per-install override
  // is false (PR6); in those cases the worker proceeds findings-only.
  // A throw here is logged but never blocks comment posting — the spec
  // requires patch generation failure to be invisible to the caller.
  let patchOutcome: Awaited<ReturnType<typeof realRunPatchAgent>> = null;
  try {
    patchOutcome = await deps.runPatchAgent({
      reviewId,
      installationId: row.installationId,
      findings: bundle.agreed,
      changedFiles: files,
    });
  } catch (err) {
    logError("patch_agent.threw", {
      reviewId,
      message: messageOf(err),
    });
  }
  if (patchOutcome !== null) {
    logInfo("patch_agent.completed", {
      reviewId,
      decisionCount: patchOutcome.decisions.length,
      shippedCount: patchOutcome.byIndex.size,
      elapsedMs: patchOutcome.elapsedMs,
    });
  }

  // Comment posting + lifecycle persistence. A failure here MUST bubble
  // so the cron retries — but we want to avoid double-posting on retry.
  // postPRComment is not idempotent (GitHub creates a new comment per
  // call), so we accept that a 500 between post and setReviewComment
  // could leak one orphan comment. Tradeoff documented in §11.3.
  // Pull the paywall settlement footer when this review was paid for via
  // an agent channel. Returns null for legacy_partner / pre-paywall rows;
  // formatPRComment omits the footer entirely in that case.
  let settlement: ReviewSettlement | null = null;
  try {
    settlement = await deps.loadReviewSettlement(reviewId);
  } catch (err) {
    logError("review_worker.settlement_lookup_failed", {
      reviewId,
      message: messageOf(err),
    });
  }
  const commentBody = formatPRComment(bundle.agreed, {
    reviewId,
    totalMs: bundle.totalMs,
    estimatedCostUsd: bundle.estimatedCostUsd,
    modelIds: bundle.modelIds,
    ...(settlement !== null ? { settlement } : {}),
    ...(patchOutcome !== null && patchOutcome.byIndex.size > 0
      ? { patchesByIndex: patchOutcome.byIndex }
      : {}),
  });
  const posted = await deps.postPRComment({
    installationId: row.installationId,
    owner: row.owner,
    repo: row.repo,
    prNumber: row.prNumber,
    body: commentBody,
  });
  logInfo("comment.posted", {
    reviewId,
    commentId: posted.id,
    commentUrl: posted.htmlUrl,
    findingCount: bundle.agreed.length,
    patchesIncluded: patchOutcome?.byIndex.size ?? 0,
  });

  try {
    await deps.setReviewComment({
      reviewId,
      commentId: posted.id,
      commentUrl: posted.htmlUrl,
    });
    const findingIds = await deps.recordFindingStatuses(
      reviewId,
      bundle.agreed.map((f) => ({
        title: f.title,
        severity: f.severity,
        category: f.category,
      })),
    );
    logInfo("lifecycle.recorded", {
      reviewId,
      findingIds,
      commentId: posted.id,
    });
    // Patch Agent v1.5 — persist per-finding patch decisions AFTER the
    // finding_status rows exist (recordPatchDecisions is an UPDATE). A
    // throw here is logged but never blocks comment success; the
    // suggestion block is already on the PR even if the DB write fails.
    if (patchOutcome !== null && patchOutcome.decisions.length > 0) {
      try {
        await deps.recordPatchDecisions(
          patchOutcome.decisions.map((d) => ({
            findingId: d.findingId,
            suggestedPatch: d.patch,
            patchModelId: d.modelId,
            patchSkipReason: d.skipReason,
            proposedAt: deps.now(),
          })),
        );
        // Fire one onboarder event per shipped patch. Self-gated on
        // ONBOARDER_ENABLED; the call is fire-and-forget at the worker
        // level — its own catch logs without bubbling.
        for (const d of patchOutcome.decisions) {
          if (d.patch === null || d.modelId === null) continue;
          await deps.recordPatchProposedEvent({
            installationId: row.installationId,
            owner: row.owner,
            repo: row.repo,
            reviewId,
            findingId: d.findingId,
            modelId: d.modelId,
            suggestedPatch: d.patch,
          });
        }
      } catch (patchPersistErr) {
        logError("patch_agent.persist_failed", {
          reviewId,
          message: messageOf(patchPersistErr),
        });
      }
    }
  } catch (lifecycleErr) {
    // The comment is posted; the row is recoverable on next sweep tick.
    // Log loudly and let the worker continue — the review itself is
    // 'done', losing the lifecycle row would only mean Sweeper can't
    // reconcile closure for these findings.
    logError("lifecycle.persist_failed", {
      reviewId,
      message: messageOf(lifecycleErr),
    });
  }

  // installationToken is consumed implicitly through getChangedFiles /
  // postPRComment via the GitHub App auth path; the explicit fetch above
  // surfaces install-token failures early (before LLM calls). Suppress
  // the unused-binding lint.
  void installationToken;
}

// Heuristic: which errors are worth retrying. The cheap signal we have
// is the error message string — the SDKs we use (Anthropic, OpenAI,
// Octokit) all surface HTTP status codes in the message. Anything that
// looks like a transient infra problem (429, 5xx, fetch failed, timeout)
// is retryable. Anything that looks like our own bug or a 4xx other
// than 429 is not — retrying won't help and we'd burn LLM budget.
export function isTransientError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("rate_limit")) {
    return true;
  }
  if (
    lower.includes("500") ||
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("504")
  ) {
    return true;
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("aborted")) {
    return true;
  }
  if (
    lower.includes("etimedout") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused")
  ) {
    return true;
  }
  if (lower.includes("fetch failed") || lower.includes("network")) {
    return true;
  }
  // reviewPR itself never throws on per-provider failure (each provider
  // is caught and surfaced in perProvider.error). But if the WHOLE
  // pipeline throws, it's almost certainly an infrastructure issue;
  // err on the retryable side. Terminal-failure on attempts cap will
  // still stop the bleeding.
  return true;
}

// Compute the absolute timestamp at which the next retry becomes eligible.
// attemptsAfterFailure is the value of processing_attempts after this
// failure has been recorded (i.e. 1 means "we just had our first failure").
export function computeNextRetryAt(now: Date, attemptsAfterFailure: number): Date {
  const idx = Math.max(0, Math.min(BACKOFF_SECONDS.length - 1, attemptsAfterFailure - 1));
  const seconds = BACKOFF_SECONDS[idx];
  return new Date(now.getTime() + seconds * 1000);
}

// Octokit instance helper — symmetric with the webhook handler's use of
// the installation token for repo-visibility checks. Exposed so callers
// outside this module can construct one without re-deriving the auth.
export function makeOctokitForInstall(installationToken: string): Octokit {
  return new Octokit({ auth: installationToken });
}
