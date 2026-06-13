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
import { isPatchAgentClickApplyEnabledForInstall as realIsPatchAgentClickApplyEnabledForInstall } from "./patch-agent-env";
import { postPatchReviewComment as realPostPatchReviewComment } from "./patch-review-comment";
import { logError, logInfo, messageOf } from "./log";
import { db } from "@/db";
import {
  loadReviewSettlement as realLoadReviewSettlement,
  type ReviewSettlement,
} from "@/lib/paywall/queries";
import {
  claimReviewForProcessing as realClaimReviewForProcessing,
  loadReviewQueueRow as realLoadReviewQueueRow,
  makeFindingId,
  markReviewFailedForRetry as realMarkReviewFailedForRetry,
  markReviewSucceeded as realMarkReviewSucceeded,
  markReviewTerminallyFailed as realMarkReviewTerminallyFailed,
  recordFindingStatuses as realRecordFindingStatuses,
  recordPatchDecisions as realRecordPatchDecisions,
  recordPatchReviewComment as realRecordPatchReviewComment,
  setReviewComment as realSetReviewComment,
  setReviewPatchCost as realSetReviewPatchCost,
  updateReview as realUpdateReview,
  type ReviewProcessingStatus,
  type ReviewQueueRow,
} from "@/db/queries";

import {
  BACKOFF_SECONDS,
  MAX_PROCESSING_ATTEMPTS,
  STUCK_AFTER_MS,
} from "./review-worker-config";
// Re-exported so existing call sites (./review-retry.ts, tests) keep working
// without an import path churn.
export { BACKOFF_SECONDS, MAX_PROCESSING_ATTEMPTS, STUCK_AFTER_MS };

export type WorkerOutcome =
  | { kind: "done"; reviewId: string; agreedCount: number; degraded: boolean }
  | { kind: "skipped"; reviewId: string; reason: string }
  | { kind: "retried"; reviewId: string; attempts: number; nextRetryAt: Date; error: string }
  | { kind: "failed"; reviewId: string; attempts: number; error: string };

// "api" is the on-demand /api/v1/installations/{id}/review path; same
// claim-source semantics as "webhook" — both arrive immediately after
// enqueue with the row in 'pending'. The string is kept distinct purely
// for log attribution so the surface that triggered each review is
// audit-readable in worker.completed events.
export type ClaimSource = "webhook" | "cron" | "api";

export type WorkerDeps = {
  getInstallationToken: typeof realGetInstallationToken;
  getChangedFiles: typeof realGetChangedFiles;
  reviewPR: typeof realReviewPR;
  postPRComment: typeof realPostPRComment;
  runFirstReviewSummary: typeof realRunFirstReviewSummary;
  recordPatchProposedEvent: typeof realRecordPatchProposedEvent;
  runPatchAgent: typeof realRunPatchAgent;
  isPatchAgentClickApplyEnabledForInstall: typeof realIsPatchAgentClickApplyEnabledForInstall;
  postPatchReviewComment: typeof realPostPatchReviewComment;
  recordPatchReviewComment: typeof realRecordPatchReviewComment;
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
    isPatchAgentClickApplyEnabledForInstall: realIsPatchAgentClickApplyEnabledForInstall,
    postPatchReviewComment: realPostPatchReviewComment,
    recordPatchReviewComment: realRecordPatchReviewComment,
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
  if (source === "webhook" || source === "api") {
    // Webhook / api both arrive immediately after enqueue — the row is
    // always 'pending' on the happy path. We refuse to claim from any
    // other state so a duplicate delivery doesn't shoulder past an
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
      // Full triage decision (or null when triage was bypassed) kept in the
      // JSONB audit trail alongside the agreement outcome.
      triage: bundle.triage,
    },
    timingMs: bundle.totalMs,
    costEstimatedUsd: bundle.estimatedCostUsd,
  });
  logInfo("review.completed", {
    reviewId,
    agreedCount: bundle.agreed.length,
    degraded: bundle.degraded,
    degradedReason: bundle.degradedReason,
    triageSkipped: bundle.triage?.worthEscalating === false,
    triageReason: bundle.triage?.reason ?? null,
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
      repo: row.repo,
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

  const inlinePatchByIndex =
    patchOutcome === null ? new Map() : (patchOutcome.inlineByIndex ?? patchOutcome.byIndex);

  // Patch Agent v1.6 — click-apply lane gate. Resolved ONCE up here so
  // both the issue-comment shape (formatPRComment receives clickApplyEnabled)
  // AND the review-comment post loop (below recordPatchDecisions) see the
  // same answer. Resolved to false on any lookup failure — conservative
  // default keeps v1.5 behavior on the rare DB hiccup.
  let clickApplyEnabled = false;
  if (patchOutcome !== null && inlinePatchByIndex.size > 0) {
    try {
      clickApplyEnabled = await deps.isPatchAgentClickApplyEnabledForInstall(
        row.installationId,
        row.repo,
      );
    } catch (err) {
      logError("patch_review_comment.gate_lookup_failed", {
        reviewId,
        message: messageOf(err),
      });
    }
  }

  // Lifecycle persistence + comment posting. Finding lifecycle rows are
  // written BEFORE the GitHub comment so a DB failure cannot leave the
  // public comment as the only record of agreed findings. setReviewComment
  // still follows the GitHub post because it needs the remote id/url; a
  // failure there bubbles so the review is not marked done without the
  // durable comment pointer.
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
    clickApplyEnabled,
  });
  const findingIds = await deps.recordFindingStatuses(
    reviewId,
    bundle.agreed.map((f) => ({
      title: f.title,
      severity: f.severity,
      category: f.category,
    })),
  );
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

  await deps.setReviewComment({
    reviewId,
    commentId: posted.id,
    commentUrl: posted.htmlUrl,
  });
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
        patchOutcome.decisions.map((d) => {
          // runPatchAgent always populates tokensByFindingId (every return
          // path sets a Map); the `?.` only tolerates loosely-typed test mocks
          // that omit the field. A missing split → all-null token columns.
          const split = patchOutcome.tokensByFindingId?.get(d.findingId);
          return {
            findingId: d.findingId,
            suggestedPatch: d.patch,
            patchModelId: d.modelId,
            patchSkipReason: d.gateOutcome,
            proposedAt: deps.now(),
            candidates: d.candidates,
            rationales: d.rationales ?? { opus: null, gpt5: null },
            skipReasons: d.skipReasons,
            selector: d.selector,
            // Migration 0029 — per-finding token spend split by provider.
            tokens: {
              inputTokensOpus: split?.opus?.inputTokens ?? null,
              outputTokensOpus: split?.opus?.outputTokens ?? null,
              inputTokensGpt5: split?.gpt5?.inputTokens ?? null,
              outputTokensGpt5: split?.gpt5?.outputTokens ?? null,
            },
          };
        }),
      );
      // Persist the aggregate patch-lane cost (observability only — the
      // drawdown column is untouched). Now a real figure: the provider SDK
      // usage blocks are threaded through ProviderPatchProposal.usage and
      // summed at token list rates in patch-cost.ts. Drawdown invariant 3:
      // this is the ONLY cost write in the click-apply path; no new payments
      // / drawdown rows touched.
      await deps.setReviewPatchCost(reviewId, patchOutcome.costPatchUsd);

      // Patch Agent v1.6 — click-apply lane runs BEFORE the patch_proposed
      // events fire so the events can carry the review_comment_id/url for
      // the v2.0 conversion metric. Each post + persist is independent;
      // a failure on one finding does not block the others, and a failure
      // of this whole block does not block the v1.5 issue comment (already
      // posted above) or the v1.5 patch_proposed events (which follow).
      // Forward-only: rows that already have patch_review_comment_id set
      // are skipped via the UPDATE predicate inside recordPatchReviewComment.
      //
      // Failure mode the audit asked us to document (≈ v1.5 §11.3): if
      // postPatchReviewComment succeeds but recordPatchReviewComment
      // throws, we leak one orphan GitHub review comment. The DB row
      // stays NULL so a worker retry on this review row would re-post;
      // but a new push creates a new review row, so the orphan does not
      // accumulate beyond one comment per failure. Acceptable per
      // non-break invariant 2; the issue comment is the contract path.
      const reviewCommentByFindingId = new Map<string, { id: number; url: string }>();
      if (clickApplyEnabled) {
        for (const [findingIndex, patch] of inlinePatchByIndex.entries()) {
          const finding = bundle.agreed[findingIndex];
          if (finding === undefined) continue;
          const ev = finding.evidence[0];
          if (ev === undefined || ev.startLine === null) continue;
          // Operator decision Q2 LOCKED: multi-line evidence falls back
          // to the v1.5 issue-comment <details> path (more brittle than
          // useful via GitHub's start_line review comments).
          const isSingleLine = ev.endLine === null || ev.endLine === ev.startLine;
          if (!isSingleLine) continue;
          const findingId = makeFindingId(reviewId, findingIndex);
          try {
            const reviewCommentPost = await deps.postPatchReviewComment({
              installationId: row.installationId,
              owner: row.owner,
              repo: row.repo,
              pullNumber: row.prNumber,
              commitId: row.commitSha,
              path: ev.path,
              line: ev.startLine,
              patch,
              bodyPrefix: `**${finding.title}** · proposed patch (model: \`${patch.modelId}\`)`,
            });
            if (reviewCommentPost === null) continue;
            await deps.recordPatchReviewComment({
              findingId,
              reviewCommentId: reviewCommentPost.id,
              reviewCommentUrl: reviewCommentPost.url,
              proposedAt: deps.now(),
            });
            reviewCommentByFindingId.set(findingId, {
              id: reviewCommentPost.id,
              url: reviewCommentPost.url,
            });
            logInfo("patch_review_comment.posted", {
              reviewId,
              findingId,
              commentId: reviewCommentPost.id,
              commentUrl: reviewCommentPost.url,
            });
          } catch (reviewCommentErr) {
            logError("patch_review_comment.post_or_persist_failed", {
              reviewId,
              findingId,
              message: messageOf(reviewCommentErr),
            });
          }
        }
      }

      // Fire one onboarder event per shipped patch. Self-gated on
      // ONBOARDER_ENABLED; the call is fire-and-forget at the worker
      // level — its own catch logs without bubbling. v1.6 plumbs the
      // review-comment id/url into tool_output when click-apply succeeded
      // for that finding (else null, matching pre-v1.6 shape).
      for (const d of patchOutcome.decisions) {
        if (d.patch === null || d.modelId === null) continue;
        const linkedComment = reviewCommentByFindingId.get(d.findingId);
        await deps.recordPatchProposedEvent({
          installationId: row.installationId,
          owner: row.owner,
          repo: row.repo,
          reviewId,
          findingId: d.findingId,
          modelId: d.modelId,
          suggestedPatch: d.patch,
          reviewCommentId: linkedComment?.id ?? null,
          reviewCommentUrl: linkedComment?.url ?? null,
        });
      }
    } catch (patchPersistErr) {
      logError("patch_agent.persist_failed", {
        reviewId,
        message: messageOf(patchPersistErr),
      });
    }
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
