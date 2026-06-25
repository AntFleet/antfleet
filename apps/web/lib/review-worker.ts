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
import {
  applyReachabilityGate as realApplyReachabilityGate,
  type ReachabilityOutcome,
} from "./reachability-gate";
import { initializeDisclosureForFindings as realInitializeDisclosureForFindings } from "./disclosure";
import { getRepoCyberTier as realGetRepoCyberTier } from "./cyber-tier";
import {
  applyPatchVerifier as realApplyPatchVerifier,
  type PatchVerifyOutcome,
  realPatchVerifierIo,
} from "./patch-verifier";
import {
  isEvidenceBundleEnabledForInstall as realIsEvidenceBundleEnabledForInstall,
  isDisclosureGateEnabledForInstall as realIsDisclosureGateEnabledForInstall,
  isDisclosureSideTableEnabled as realIsDisclosureSideTableEnabled,
  isReachabilityGateEnabledForInstall as realIsReachabilityGateEnabledForInstall,
  isPatchVerifyEnabledForInstall as realIsPatchVerifyEnabledForInstall,
  isThreatModelEnabledForInstall as realIsThreatModelEnabledForInstall,
} from "./daybreak-gates-env";
import { alertCritical } from "./alert";
import { logError, logInfo, messageOf } from "./log";
import { db } from "@/db";
import {
  loadReviewSettlement as realLoadReviewSettlement,
  type ReviewSettlement,
} from "@/lib/paywall/queries";
import {
  claimReviewForProcessing as realClaimReviewForProcessing,
  loadReviewQueueRow as realLoadReviewQueueRow,
  loadRepoThreatModel as realLoadRepoThreatModel,
  makeFindingId,
  markReviewExhaustedIfStale as realMarkReviewExhaustedIfStale,
  markReviewFailedForRetry as realMarkReviewFailedForRetry,
  markReviewSucceeded as realMarkReviewSucceeded,
  markReviewTerminallyFailed as realMarkReviewTerminallyFailed,
  recordFindingStatuses as realRecordFindingStatuses,
  recordFindingEvidenceBundleSlot as realRecordFindingEvidenceBundleSlot,
  recordGateOutcome as realRecordGateOutcome,
  recordPatchDecisions as realRecordPatchDecisions,
  recordPatchReviewComment as realRecordPatchReviewComment,
  setReviewComment as realSetReviewComment,
  setReviewPatchCost as realSetReviewPatchCost,
  upsertRepoThreatModel as realUpsertRepoThreatModel,
  updateReview as realUpdateReview,
  type EvidenceBundleSlot,
  type ReviewProcessingStatus,
  type ReviewQueueRow,
} from "@/db/queries";
import {
  generateRepoThreatModel,
  getRepoThreatModelFilesWith,
  parseRepoThreatModelDocument,
  publicAccessForThreatModel,
  repoThreatModelPersistence,
  toReachabilityThreatModel,
  updateRepoThreatModel,
  type RepoThreatModelForReachability,
  type RepoThreatModelSnapshot,
  type ThreatModelPublicAccess,
} from "./repo-threat-model";

import { BACKOFF_SECONDS, MAX_PROCESSING_ATTEMPTS, STUCK_AFTER_MS } from "./review-worker-config";
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
  getRepoThreatModelFiles: typeof realGetRepoThreatModelFiles;
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
  markReviewExhaustedIfStale: typeof realMarkReviewExhaustedIfStale;
  loadReviewSettlement: (reviewId: string) => Promise<ReviewSettlement | null>;
  // Daybreak — reachability gate + patch verifier deps. Both default to
  // the real implementations; tests can inject no-ops. Each is paired
  // with its env-flag resolver so the kernel can short-circuit when the
  // flag is off (no LLM call, no /tmp worktree, no DB write).
  applyReachabilityGate: typeof realApplyReachabilityGate;
  applyPatchVerifier: typeof realApplyPatchVerifier;
  recordGateOutcome: typeof realRecordGateOutcome;
  loadRepoThreatModel: typeof realLoadRepoThreatModel;
  upsertRepoThreatModel: typeof realUpsertRepoThreatModel;
  recordFindingEvidenceBundleSlot: typeof realRecordFindingEvidenceBundleSlot;
  initializeDisclosureForFindings: typeof realInitializeDisclosureForFindings;
  isDisclosureSideTableEnabled: typeof realIsDisclosureSideTableEnabled;
  isReachabilityGateEnabledForInstall: typeof realIsReachabilityGateEnabledForInstall;
  isPatchVerifyEnabledForInstall: typeof realIsPatchVerifyEnabledForInstall;
  isThreatModelEnabledForInstall: typeof realIsThreatModelEnabledForInstall;
  isEvidenceBundleEnabledForInstall: typeof realIsEvidenceBundleEnabledForInstall;
  isDisclosureGateEnabledForInstall: typeof realIsDisclosureGateEnabledForInstall;
  getRepoCyberTier: typeof realGetRepoCyberTier;
  now: () => Date;
};

export function realWorkerDeps(): WorkerDeps {
  return {
    getInstallationToken: realGetInstallationToken,
    getChangedFiles: realGetChangedFiles,
    getRepoThreatModelFiles: realGetRepoThreatModelFiles,
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
    markReviewExhaustedIfStale: realMarkReviewExhaustedIfStale,
    loadReviewSettlement: (reviewId) => realLoadReviewSettlement(db, reviewId),
    applyReachabilityGate: realApplyReachabilityGate,
    applyPatchVerifier: realApplyPatchVerifier,
    recordGateOutcome: realRecordGateOutcome,
    loadRepoThreatModel: realLoadRepoThreatModel,
    upsertRepoThreatModel: realUpsertRepoThreatModel,
    recordFindingEvidenceBundleSlot: realRecordFindingEvidenceBundleSlot,
    initializeDisclosureForFindings: realInitializeDisclosureForFindings,
    isDisclosureSideTableEnabled: realIsDisclosureSideTableEnabled,
    isReachabilityGateEnabledForInstall: realIsReachabilityGateEnabledForInstall,
    isPatchVerifyEnabledForInstall: realIsPatchVerifyEnabledForInstall,
    isThreatModelEnabledForInstall: realIsThreatModelEnabledForInstall,
    isEvidenceBundleEnabledForInstall: realIsEvidenceBundleEnabledForInstall,
    isDisclosureGateEnabledForInstall: realIsDisclosureGateEnabledForInstall,
    getRepoCyberTier: realGetRepoCyberTier,
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
  // Attempts cap pre-claim. A worker killed at maxDuration leaves the row
  // in_progress without reaching its catch; the next cron tick re-claims
  // and bumps attempts. Once attempts has hit the cap, terminalize before
  // running the pipeline again — otherwise public-API pollers see this row
  // in_progress forever even though it is dead.
  //
  // markReviewExhaustedIfStale is an atomic UPDATE gated on the same stuck
  // predicate the loader uses (in_progress + processingStartedAt older than
  // stuckBefore). If a competing worker claimed the row between the loader
  // tick and this check, its claim refreshed processingStartedAt and the
  // UPDATE matches nothing — we skip rather than racing the live claim.
  if (row.processingAttempts >= MAX_PROCESSING_ATTEMPTS) {
    const now = deps.now();
    const stuckBefore = new Date(now.getTime() - STUCK_AFTER_MS);
    const error = `processing attempts exhausted (>=${MAX_PROCESSING_ATTEMPTS})`;
    const terminalized = await deps.markReviewExhaustedIfStale({
      reviewId,
      maxAttempts: MAX_PROCESSING_ATTEMPTS,
      stuckBefore,
      now,
      error,
    });
    if (terminalized) {
      logError("worker.attempts_exhausted", {
        reviewId,
        source,
        attempts: row.processingAttempts,
      });
      alertCritical("worker.failed", {
        reviewId,
        source,
        attempts: row.processingAttempts,
        reason: "attempts_exhausted",
        error,
      });
      return { kind: "failed", reviewId, attempts: row.processingAttempts, error };
    }
    // Another worker freshly claimed it before us; back off.
    return { kind: "skipped", reviewId, reason: "exhausted_but_freshly_claimed" };
  }
  const { installationId, owner, repo } = row;
  if (installationId === null || owner === null || repo === null) {
    logError("worker.missing_dispatch_context", { reviewId, source });
    await deps.markReviewTerminallyFailed({
      reviewId,
      now: deps.now(),
      error: "missing installation/owner/repo on row",
    });
    alertCritical("worker.failed", {
      reviewId,
      source,
      reason: "missing_dispatch_context",
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
  const claimNow = deps.now();
  // stuckBefore gates the in_progress claim path against a competing
  // cron tick that already refreshed processingStartedAt. For
  // webhook/api sources the in_progress branch isn't legal, but we still
  // pass it to keep the claim API call-shape uniform.
  const stuckBefore = new Date(claimNow.getTime() - STUCK_AFTER_MS);
  const claimed = await deps.claimReviewForProcessing({
    reviewId,
    fromStatuses,
    now: claimNow,
    stuckBefore,
  });
  if (!claimed) {
    // Another worker beat us. This is the expected race outcome when the
    // webhook's after() and the retry cron both reach the same row.
    return { kind: "skipped", reviewId, reason: "lost_claim_race" };
  }

  const attemptsAfterClaim = row.processingAttempts + 1;

  try {
    await processClaimedRow(reviewId, dispatchRow, deps, attemptsAfterClaim);
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
      alertCritical("worker.failed", {
        reviewId,
        source,
        attempts: attemptsAfterClaim,
        retryable,
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

// Shared review-execution kernel (audit T2.3). Single place where the
// review lifecycle runs end-to-end: dispatch → reviewPR → agreement
// decision (including triage) → persist responses → record finding
// statuses → install-only lanes (onboarder + patch agent + PR comment +
// click-apply). Both the installation worker (processClaimedRow below)
// AND the paid x402/ACP job-worker invoke this single kernel; the
// install rail passes the `installLane` dep set to enable patch+comment;
// the paid rails leave it unset to ship the deliverable through x402/
// ACP submission instead of GitHub comment.
//
// What the kernel guarantees:
//   - `agreementDecision` includes `triage` on EVERY persistence branch
//     (empty files = skipped shape; cost-cap overflow; success). The
//     paid-path drift this audit fixes was triage being dropped from the
//     success branch — a triage-skip became indistinguishable from a real
//     empty consensus in the JSONB audit trail.
//   - The optional `costCap` gate persists the bundle (with triage)
//     BEFORE throwing `cost_cap_exceeded`, so the audit trail survives
//     even when the review is refused for cost reasons.
//   - The optional `signal` is forwarded into `reviewPR` so paid-rail
//     callers can enforce a wall-clock timeout.
//   - The optional `installLane` deps enable the install-only stages
//     (onboarder, patch agent, PR comment, click-apply review comments,
//     settlement footer). When undefined, the kernel returns after
//     persistence; paid rails opt out this way because they don't post
//     to GitHub.
//
// What the kernel does NOT do (caller responsibility):
//   - mark the review row succeeded (callers settle the review row in
//     their own catch/finally — installation through `runReviewWorker`,
//     paid through their billing wrapper)
//   - fetch files: callers pass them in, since the installation rail
//     uses an install-token client and the paid rails use the public
//     Octokit
//
// Return shape:
//   - `{ kind: "skipped" }` when files is empty (caller decides whether
//     to mark succeeded — x402 does, installation does, ACP throws)
//   - `{ kind: "completed", bundle, findingIds }` on a normal completion.
//     `findingIds` is the array returned by recordFindingStatuses (empty
//     when no agreed findings or when the review degraded).
export type ReviewKernelOutcome =
  | { kind: "skipped" }
  | {
      kind: "completed";
      bundle: Awaited<ReturnType<typeof realReviewPR>>;
      findingIds: string[];
    };

export type ReviewKernelDeps = {
  reviewPR: typeof realReviewPR;
  updateReview: typeof realUpdateReview;
  recordFindingStatuses: typeof realRecordFindingStatuses;
  loadRepoThreatModel: typeof realLoadRepoThreatModel;
  upsertRepoThreatModel: typeof realUpsertRepoThreatModel;
  // Daybreak — reachability gate plumbing. The kernel-side hook runs on
  // every rail (install + paid + acp) because the gate question — "is this
  // bug reachable from a real entry point?" — is rail-agnostic. Disabled
  // by default in prod via env flag; on in bench.
  applyReachabilityGate: typeof realApplyReachabilityGate;
  recordGateOutcome: typeof realRecordGateOutcome;
  recordFindingEvidenceBundleSlot: typeof realRecordFindingEvidenceBundleSlot;
  initializeDisclosureForFindings: typeof realInitializeDisclosureForFindings;
  // Resolver receives an installationId / repo so future per-install
  // overrides slot in without a churning signature.
  isReachabilityGateEnabledForInstall: typeof realIsReachabilityGateEnabledForInstall;
  isThreatModelEnabledForInstall: typeof realIsThreatModelEnabledForInstall;
  isEvidenceBundleEnabledForInstall: typeof realIsEvidenceBundleEnabledForInstall;
  isDisclosureGateEnabledForInstall: typeof realIsDisclosureGateEnabledForInstall;
  isDisclosureSideTableEnabled: typeof realIsDisclosureSideTableEnabled;
  getRepoCyberTier: typeof realGetRepoCyberTier;
};

// Install-only lane deps. When the caller (installation rail) wires
// these, the kernel runs the onboarder + patch agent + PR comment +
// click-apply stages after persistence. Paid rails leave it undefined
// to opt out.
export type ReviewKernelInstallLane = {
  installationId: number;
  commitSha: string;
  runFirstReviewSummary: typeof realRunFirstReviewSummary;
  runPatchAgent: typeof realRunPatchAgent;
  isPatchAgentClickApplyEnabledForInstall: typeof realIsPatchAgentClickApplyEnabledForInstall;
  postPatchReviewComment: typeof realPostPatchReviewComment;
  recordPatchReviewComment: typeof realRecordPatchReviewComment;
  loadReviewSettlement: (reviewId: string) => Promise<ReviewSettlement | null>;
  postPRComment: typeof realPostPRComment;
  setReviewComment: typeof realSetReviewComment;
  recordPatchDecisions: typeof realRecordPatchDecisions;
  setReviewPatchCost: typeof realSetReviewPatchCost;
  recordPatchProposedEvent: typeof realRecordPatchProposedEvent;
  // Daybreak — patch verifier plumbing. Runs after the patch agent emits
  // proposals and BEFORE we persist / post them. Disabled by default in
  // prod via env flag; on in bench. The verifier needs git+spawn+/tmp so
  // serverless runtimes return inconclusive across the board until the
  // operator routes the install rail through a backing service.
  applyPatchVerifier: typeof realApplyPatchVerifier;
  recordGateOutcome: typeof realRecordGateOutcome;
  recordFindingEvidenceBundleSlot: typeof realRecordFindingEvidenceBundleSlot;
  isPatchVerifyEnabledForInstall: typeof realIsPatchVerifyEnabledForInstall;
  now: () => Date;
};

export type ReviewKernelArgs = {
  reviewId: string;
  repoHash: string;
  owner: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  publicReceipt: boolean;
  files: Parameters<typeof realReviewPR>[0]["files"];
  threatModelSnapshot?: RepoThreatModelSnapshot | null;
  liveProtocolReviewRequired?: boolean;
  // Forwarded into reviewPR — paid rails set this so the kernel respects
  // the rail's wall-clock budget.
  signal?: AbortSignal;
  // Optional billing-rail tag attached to providerResponses (e.g. "x402",
  // "acp"). Installation reviews pass undefined and the field is absent.
  rail?: string;
  // Optional cost cap. When the bundle's estimatedCostUsd exceeds
  // `priceUsdc * 3` (the existing paywall cap), the kernel persists the
  // bundle (with triage) and throws an error tagged with
  // `failureModeTag: "cost_cap_exceeded"`. Caller decides whether to
  // continue (installation rail passes undefined).
  costCap?: { readPriceUsdc: () => string; errorMessage: string };
  // Optional install-only lane. Enables onboarder + patch agent + PR
  // comment + click-apply. Paid rails leave this undefined.
  installLane?: ReviewKernelInstallLane;
  // Review attempt this invocation belongs to. Threaded into
  // review_gate_outcomes rows so the side-table's duplicate-on-retry
  // shape is queryable (which attempt produced which verdict). Callers
  // who don't track attempts pass undefined → defaults to 1.
  reviewAttempt?: number;
};

type AgreedFinding = Awaited<ReturnType<typeof realReviewPR>>["agreed"][number];

function evidenceSlot(args: {
  producedBy: "reviewer_consensus" | "patch_verifier" | "reachability_gate";
  sourceGateOutcomeId: string | null;
  modelId: string | null;
  reviewedSha: string;
  reviewAttempt: number;
  value: unknown;
}): EvidenceBundleSlot {
  return {
    value: args.value,
    provenance: {
      producedBy: args.producedBy,
      sourceGateOutcomeId: args.sourceGateOutcomeId,
      modelId: args.modelId,
      reviewedSha: args.reviewedSha,
      producedAt: new Date().toISOString(),
      reviewAttempt: args.reviewAttempt,
    },
  };
}

function callPathTraceSlot(args: {
  outcome: ReachabilityOutcome;
  sourceGateOutcomeId: string;
  reviewedSha: string;
  reviewAttempt: number;
}): EvidenceBundleSlot | null {
  if (args.outcome.entryPoint === null || args.outcome.callPath.length === 0) return null;
  return evidenceSlot({
    producedBy: "reachability_gate",
    sourceGateOutcomeId: args.sourceGateOutcomeId,
    modelId: args.outcome.modelId,
    reviewedSha: args.reviewedSha,
    reviewAttempt: args.reviewAttempt,
    value: {
      verdict: args.outcome.verdict,
      entryPoint: args.outcome.entryPoint,
      callPath: args.outcome.callPath,
      reason: args.outcome.reason,
    },
  });
}

function patchVerifyEvidenceSlots(args: {
  finding: AgreedFinding | undefined;
  outcome: PatchVerifyOutcome;
  sourceGateOutcomeId: string;
  reviewerModelIds: Record<string, string>;
  reviewedSha: string;
  reviewAttempt: number;
}): { pocSnippet: EvidenceBundleSlot | null; reproductionCommand: EvidenceBundleSlot | null } {
  const command = publicVerifierCommand(args.outcome.pocCmd);
  if (command === null) {
    return { pocSnippet: null, reproductionCommand: null };
  }
  void args.finding;
  return {
    pocSnippet: evidenceSlot({
      producedBy: "patch_verifier",
      sourceGateOutcomeId: args.sourceGateOutcomeId,
      modelId: null,
      reviewedSha: args.reviewedSha,
      reviewAttempt: args.reviewAttempt,
      value: { text: command },
    }),
    reproductionCommand: evidenceSlot({
      producedBy: "patch_verifier",
      sourceGateOutcomeId: args.sourceGateOutcomeId,
      modelId: null,
      reviewedSha: args.reviewedSha,
      reviewAttempt: args.reviewAttempt,
      value: {
        command,
        pocExitCode: args.outcome.pocExitCode,
        pocMs: args.outcome.pocMs,
        verifierVerdict: args.outcome.verdict,
        notes: args.outcome.notes,
      },
    }),
  };
}

function publicVerifierCommand(command: string | null): string | null {
  if (command === null) return null;
  const trimmed = command.trim();
  if (trimmed.length === 0 || trimmed.length > 1000) return null;
  if (/[\r\n]/u.test(trimmed)) return null;
  return trimmed;
}

export async function runReviewKernel(
  args: ReviewKernelArgs,
  deps: ReviewKernelDeps,
): Promise<ReviewKernelOutcome> {
  const { reviewId, owner, repo, prNumber, commitSha, files, signal, rail } = args;

  // Resolve cyber tier BEFORE the empty-files branch so the
  // publicReceipt materialization fires even when the review never
  // produces findings. (Code audit pass-5, severity medium,
  // concurrency.) An empty review on a repo that flipped to cyber
  // between enqueue and processing would otherwise keep
  // `reviews.publicReceipt=true`, and a later flip back to default
  // would un-hide a row that was processed under cyber policy.
  const cyberTierForReview = await deps.getRepoCyberTier(owner, repo);
  const effectivePublicReceipt = cyberTierForReview === "cyber" ? false : args.publicReceipt;
  if (cyberTierForReview === "cyber" && args.publicReceipt) {
    await deps.updateReview(reviewId, { publicReceipt: false });
  }

  if (files.length === 0) {
    const providerResponses: Record<string, unknown> = {
      status: "skipped",
      reason: "no reviewable files",
    };
    if (rail !== undefined) providerResponses["rail"] = rail;
    await deps.updateReview(reviewId, {
      filesReviewed: [],
      providerResponses,
      agreementDecision: { status: "skipped" },
    });
    logInfo("review.skipped", { reviewId, reason: "no reviewable files" });
    return { kind: "skipped" };
  }

  const installationId = args.installLane?.installationId ?? null;
  const bundle = await deps.reviewPR({
    files,
    owner,
    repo,
    prNumber,
    tier: cyberTierForReview,
    ...(signal !== undefined ? { signal } : {}),
  });

  const reviewPublicAccess = publicAccessForThreatModel({
    owner,
    repo,
    publicReceipt: effectivePublicReceipt,
    cyberTier: cyberTierForReview,
  });
  // The cyber tier was already resolved above (before reviewPR) so the
  // prompt-routing layer and the visibility/embargo layer use exactly
  // the same value within one review — defense in depth (per the design
  // note: "neither path alone is sufficient").
  const liveProtocolReviewRequired =
    args.liveProtocolReviewRequired === true ||
    (installationId === null && reviewPublicAccess === "live_protocol_review_required");
  let evidenceBundleEnabled = false;
  try {
    evidenceBundleEnabled = await deps.isEvidenceBundleEnabledForInstall(installationId, repo);
  } catch (err) {
    logError("evidence_bundle.gate_lookup_failed", {
      reviewId,
      message: messageOf(err),
    });
  }

  let threatModelForReachability: RepoThreatModelForReachability | null = null;
  try {
    const threatModelEnabled = await deps.isThreatModelEnabledForInstall(installationId, repo);
    if (threatModelEnabled) {
      const existing = await deps.loadRepoThreatModel(args.repoHash);
      const existingDocument =
        existing === null ? null : parseRepoThreatModelDocument(existing.model);
      const publicAccess = reviewPublicAccess;
      let document = existingDocument;
      let refreshCount = existing?.refreshCount ?? 1;
      let shouldPersist = false;
      let persistencePublicAccess = publicAccess;
      let regeneratedFromSnapshot = false;

      if (document === null) {
        if (args.threatModelSnapshot === undefined || args.threatModelSnapshot === null) {
          logInfo("repo_threat_model.generation_skipped", {
            reviewId,
            reason:
              args.threatModelSnapshot === null
                ? "repo_file_snapshot_failed"
                : "repo_file_snapshot_unavailable",
          });
        } else {
          document = generateRepoThreatModel({
            owner,
            repo,
            repoHash: args.repoHash,
            sha: commitSha,
            files: args.threatModelSnapshot.files,
          });
          shouldPersist = true;
          logInfo("repo_threat_model.generated", {
            reviewId,
            sourceFileCount: args.threatModelSnapshot.files.length,
          });
        }
      } else if (
        existing !== null &&
        existing.publicAccess !== "public" &&
        publicAccess === "public"
      ) {
        if (args.threatModelSnapshot === undefined || args.threatModelSnapshot === null) {
          persistencePublicAccess = storedThreatModelPublicAccess(existing.publicAccess);
          logInfo("repo_threat_model.publication_deferred", {
            reviewId,
            reason:
              args.threatModelSnapshot === null
                ? "repo_file_snapshot_failed"
                : "repo_file_snapshot_unavailable",
          });
        } else {
          document = generateRepoThreatModel({
            owner,
            repo,
            repoHash: args.repoHash,
            sha: commitSha,
            files: args.threatModelSnapshot.files,
          });
          refreshCount += 1;
          shouldPersist = true;
          regeneratedFromSnapshot = true;
          logInfo("repo_threat_model.regenerated_for_publication", {
            reviewId,
            sourceFileCount: args.threatModelSnapshot.files.length,
          });
        }
      }

      if (document !== null && existingDocument === null) {
        shouldPersist = true;
      }

      if (document !== null && existing !== null) {
        shouldPersist =
          shouldPersist ||
          existing.lastReviewedSha !== commitSha ||
          existing.publicAccess !== persistencePublicAccess;
      }

      if (existingDocument !== null && !regeneratedFromSnapshot) {
        const updated = updateRepoThreatModel({
          existing: existingDocument,
          sha: commitSha,
          changedFiles: files,
          repoPaths: args.threatModelSnapshot?.paths ?? null,
        });
        document = updated.document;
        if (updated.changed) {
          refreshCount += 1;
          shouldPersist = true;
          logInfo("repo_threat_model.refreshed", {
            reviewId,
            sections: updated.refreshedSections,
          });
        }
      }

      if (document !== null && shouldPersist) {
        await deps.upsertRepoThreatModel(
          repoThreatModelPersistence({
            document,
            sha: commitSha,
            refreshCount,
            publicAccess: persistencePublicAccess,
          }),
        );
      }
      threatModelForReachability = toReachabilityThreatModel(document);
    }
  } catch (err) {
    logError("repo_threat_model.threw", {
      reviewId,
      message: messageOf(err),
    });
  }

  // Daybreak — reachability gate. Runs on EVERY rail (install + paid +
  // acp) — the question "is this bug reachable from a real entry point?"
  // is rail-agnostic. The resolver takes `installationId | null`; paid
  // rails pass null and fall through to the env-default boolean (no
  // per-install override available — by design). On `unreachable`, the
  // matching agreed finding is re-graded to LOW with the reason
  // appended to the title BEFORE `agreementDecision` is persisted. We
  // deliberately keep the consensus stage itself untouched — this is a
  // downstream re-grade, not a re-vote.
  //
  // A throw inside the gate must NOT block the review. We catch + log
  // and proceed with the un-gated bundle. The applier itself fails open
  // per-finding ('uncertain' on any model/parse error).
  //
  // Persistence of the per-finding gate outcomes is DEFERRED until after
  // `recordFindingStatuses` runs (~50 lines below). That ordering matters
  // because `recordFindingStatuses` preserves legacy finding_ids on
  // retried reviews — computing the id here via `makeFindingId(reviewId,
  // index)` would silently break the side-table join for any review
  // whose first attempt landed before this PR. The closure captures the
  // gate rows; the worker calls it after `findingIds` is allocated and
  // we read the canonical id from there.
  let reachabilityOutcomes: Array<{ index: number; reason: string; originalSeverity: string }> = [];
  let agreedRaw: typeof bundle.agreed | null = null;
  let deferredGatePersistence: ((findingIds: readonly string[]) => Promise<void>) | null = null;
  // Per-rail wall-clock cap on the gate. Each Haiku call has its own
  // 45s timeout + retries inside the SDK, but the applier runs them
  // sequentially across N HIGH/CRITICAL findings. During an Anthropic
  // outage the worst case (5 findings × 3 attempts × 45s = ~11 min)
  // would swallow most of an x402 review's wall-clock budget before the
  // outer signal aborts. We bound the WHOLE gate sequence at 60s; if
  // it exceeds that, the catch below logs and the review proceeds with
  // the un-gated bundle. The per-finding fail-open semantics still
  // apply for any findings the gate did decide on before the cap.
  const REACHABILITY_GATE_CAP_MS = 60_000;
  if (!bundle.degraded && bundle.agreed.length > 0) {
    try {
      const enabled = await deps.isReachabilityGateEnabledForInstall(installationId, repo);
      if (enabled) {
        // Snapshot the raw consensus output BEFORE applying gate
        // downgrades so the agreementDecision JSONB carries both the
        // pre-gate audit trail (`agreedRawByGate`) and the post-gate
        // shape (`agreed`). Downstream consumers reading
        // `agreementDecision.agreed[i].severity` still see the canonical
        // re-graded value; auditors can correlate against the raw shape.
        agreedRaw = bundle.agreed.map((f) => ({ ...f }));
        // Gate-local AbortController so the cap actually CANCELS the
        // in-flight Haiku call instead of just timing out the worker's
        // await. Without this, a slow Anthropic call keeps billing
        // tokens and burning a connection slot for ~2 more minutes
        // (45s SDK timeout × 1+retries) after we've already moved on.
        // The applier loop checks `signal.aborted` between findings to
        // short-circuit post-cap iterations.
        const gateController = new AbortController();
        const outerSignal = signal;
        if (outerSignal !== undefined) {
          // Propagate an outer-rail abort into the gate too.
          outerSignal.addEventListener("abort", () => gateController.abort(), { once: true });
        }
        const applierPromise = deps.applyReachabilityGate({
          agreed: bundle.agreed,
          owner,
          repo,
          files,
          threatModel: threatModelForReachability,
          signal: gateController.signal,
        });
        let capTimer: ReturnType<typeof setTimeout> | null = null;
        const capPromise = new Promise<never>((_, reject) => {
          capTimer = setTimeout(() => {
            gateController.abort();
            reject(
              Object.assign(
                new Error(`reachability gate exceeded ${REACHABILITY_GATE_CAP_MS}ms cap`),
                { failureModeTag: "timeout" },
              ),
            );
          }, REACHABILITY_GATE_CAP_MS);
        });
        // Mute the loser's rejection on the happy path to silence
        // unhandledRejection warnings in stricter runtimes.
        applierPromise.catch(() => undefined);
        const applied = await Promise.race([applierPromise, capPromise]).finally(() => {
          if (capTimer !== null) clearTimeout(capTimer);
        });
        bundle.agreed = applied.agreed;
        // Defer per-finding persistence until `recordFindingStatuses`
        // allocates the canonical finding_ids (which preserves legacy
        // short-form ids on retries). The closure captures the gate
        // rows; the worker invokes it below with the allocated array.
        // Fallback to makeFindingId(reviewId, index) when the array is
        // shorter than expected (defensive — shouldn't happen given
        // recordFindingStatuses returns one id per agreed finding).
        const capturedRows = applied.rows;
        const attempt = args.reviewAttempt ?? 1;
        deferredGatePersistence = async (findingIds) => {
          for (const row of capturedRows) {
            const findingId = findingIds[row.index] ?? makeFindingId(reviewId, row.index);
            let gateOutcomeId: string | null = null;
            try {
              gateOutcomeId = await deps.recordGateOutcome(reviewId, {
                findingId,
                stage: "reachability",
                verdict: row.outcome.verdict,
                evidence: row.outcome,
                modelId: row.outcome.modelId,
                reviewAttempt: attempt,
              });
            } catch (persistErr) {
              // Non-fatal — gate outcome rows are observability-only.
              logError("reachability_gate.persist_failed", {
                reviewId,
                findingId,
                message: messageOf(persistErr),
              });
            }
            if (evidenceBundleEnabled && gateOutcomeId !== null) {
              const slot = callPathTraceSlot({
                outcome: row.outcome,
                sourceGateOutcomeId: gateOutcomeId,
                reviewedSha: commitSha,
                reviewAttempt: attempt,
              });
              if (slot !== null) {
                try {
                  await deps.recordFindingEvidenceBundleSlot({
                    reviewId,
                    findingId,
                    reviewAttempt: attempt,
                    affectedSha: commitSha,
                    callPathTrace: slot,
                  });
                } catch (persistErr) {
                  logError("evidence_bundle.reachability_persist_failed", {
                    reviewId,
                    findingId,
                    message: messageOf(persistErr),
                  });
                }
              }
            }
          }
        };
        reachabilityOutcomes = applied.downgrades.map((d) => ({
          index: d.index,
          reason: d.reason,
          originalSeverity: agreedRaw![d.index]?.severity ?? "unknown",
        }));
        logInfo("reachability_gate.completed", {
          reviewId,
          gated: applied.rows.length,
          downgraded: applied.downgrades.length,
        });
      }
    } catch (err) {
      logError("reachability_gate.threw", {
        reviewId,
        message: messageOf(err),
      });
    }
  }

  // Full agreement-decision shape, shared across cost-cap + success
  // branches. Triage is included unconditionally — see the kernel
  // contract above. `agreed` here reflects the post-reachability-gate
  // state when the gate fired; the architect-recommended `agreedRawByGate`
  // field preserves the pre-gate consensus shape for auditability.
  const agreementDecision = {
    mode: bundle.agreementMode,
    agreed: bundle.agreed,
    disagreements: bundle.disagreements,
    degraded: bundle.degraded,
    degradedReason: bundle.degradedReason,
    triage: bundle.triage,
    reachabilityGate:
      reachabilityOutcomes.length > 0
        ? { downgrades: reachabilityOutcomes, agreedRawByGate: agreedRaw }
        : undefined,
  };
  const providerResponses: Record<string, unknown> = { perProvider: bundle.perProvider };
  if (rail !== undefined) providerResponses["rail"] = rail;

  if (args.costCap !== undefined) {
    const price = Number(args.costCap.readPriceUsdc());
    if (Number.isFinite(price) && bundle.estimatedCostUsd > price * 3) {
      await deps.updateReview(reviewId, {
        filesReviewed: files.map((f) => f.filename),
        providerModelIds: bundle.modelIds,
        providerResponses,
        agreementDecision,
        timingMs: bundle.totalMs,
        costEstimatedUsd: bundle.estimatedCostUsd,
      });
      throw Object.assign(new Error(args.costCap.errorMessage), {
        failureModeTag: "cost_cap_exceeded",
      });
    }
  }

  await deps.updateReview(reviewId, {
    filesReviewed: files.map((f) => f.filename),
    providerModelIds: bundle.modelIds,
    providerResponses,
    agreementDecision,
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

  // recordFindingStatuses is only useful for non-degraded reviews with
  // at least one agreed finding — degraded/empty consensus reviews
  // never surface findings to consumers.
  let findingIds: string[] = [];
  let embargoedDisclosureIndexes = new Set<number>();
  if (!bundle.degraded && bundle.agreed.length > 0) {
    findingIds = await deps.recordFindingStatuses(
      reviewId,
      bundle.agreed.map((f) => ({
        title: f.title,
        severity: f.severity,
        category: f.category,
      })),
    );
  }

  if (evidenceBundleEnabled && findingIds.length > 0) {
    const attempt = args.reviewAttempt ?? 1;
    for (const findingId of findingIds) {
      try {
        await deps.recordFindingEvidenceBundleSlot({
          reviewId,
          findingId,
          reviewAttempt: attempt,
          affectedSha: commitSha,
        });
      } catch (persistErr) {
        logError("evidence_bundle.empty_persist_failed", {
          reviewId,
          findingId,
          message: messageOf(persistErr),
        });
      }
    }
  }

  if (findingIds.length > 0) {
    try {
      const disclosureEnabled = await deps.isDisclosureGateEnabledForInstall(installationId, repo);
      // Cyber tier is its OWN trigger for disclosure init: even if the
      // disclosure-gate / backfill flags are off, a cyber-tier repo MUST
      // embargo every finding. Otherwise an operator enabling cyber tier
      // without first flipping the disclosure flags would leave cyber
      // findings publicly post-able from the install lane. (Architect
      // audit pass-1, severity high, flag-boundary.)
      const cyberTierForDisclosure = cyberTierForReview === "cyber";
      if (disclosureEnabled || deps.isDisclosureSideTableEnabled() || cyberTierForDisclosure) {
        // Use the SAME tier value resolved before reviewPR (and consumed
        // by the prompt-routing layer). An operator flip mid-review must
        // not split prompt and disclosure: if the model saw the cyber
        // preamble it generated PoC/repro detail, so disclosure MUST
        // embargo. (Code + security audit pass-1, severity high,
        // race-condition / consistency.)
        const disclosure = await deps.initializeDisclosureForFindings({
          reviewId,
          owner,
          repo,
          installationId,
          commitSha,
          prNumber,
          publicReceipt: effectivePublicReceipt,
          liveProtocolReviewRequired,
          routeLiveProtocolEmbargo: disclosureEnabled,
          cyberTier: cyberTierForReview,
          agreementDecision,
          providerResponses,
          findings: bundle.agreed.map((finding, index) => ({
            findingId: findingIds[index] ?? makeFindingId(reviewId, index),
            findingIndex: index,
            title: finding.title,
            severity: finding.severity,
            category: finding.category,
          })),
        });
        embargoedDisclosureIndexes = new Set(disclosure.embargoedFindingIndexes);
      }
    } catch (persistErr) {
      logError("disclosure.initialize_failed", {
        reviewId,
        message: messageOf(persistErr),
      });
      throw persistErr;
    }
  }

  // Flush the deferred reachability gate persistence now that the
  // canonical finding_ids are allocated. Done after recordFindingStatuses
  // so the side-table's finding_id can be joined back to finding_status
  // even on retried reviews where the lifecycle preserves legacy ids.
  if (deferredGatePersistence !== null) {
    try {
      await deferredGatePersistence(findingIds);
    } catch (persistErr) {
      // Defensive — the closure already catches per-row; an outer
      // throw would only come from a bug, but we log and proceed.
      logError("reachability_gate.deferred_persist_failed", {
        reviewId,
        message: messageOf(persistErr),
      });
    }
  }

  if (args.installLane !== undefined) {
    await runInstallLane({
      reviewId,
      owner,
      repo,
      prNumber,
      bundle,
      files,
      findingIds,
      reviewAttempt: args.reviewAttempt ?? 1,
      evidenceBundleEnabled,
      embargoedDisclosureIndexes,
      lane: args.installLane,
    });
  }

  return {
    kind: "completed",
    bundle: redactBundleForPublicDisclosure(bundle, embargoedDisclosureIndexes),
    findingIds: redactFindingIdsForPublicDisclosure(findingIds, embargoedDisclosureIndexes),
  };
}

type ReviewBundle = Awaited<ReturnType<typeof realReviewPR>>;

function redactBundleForPublicDisclosure(
  bundle: ReviewBundle,
  embargoedIndexes: ReadonlySet<number>,
): ReviewBundle {
  if (embargoedIndexes.size === 0) return bundle;
  return {
    ...bundle,
    agreed: publicAgreedFindings(bundle.agreed, embargoedIndexes),
  };
}

function publicAgreedFindings(
  findings: ReviewBundle["agreed"],
  embargoedIndexes: ReadonlySet<number>,
): ReviewBundle["agreed"] {
  if (embargoedIndexes.size === 0) return findings;
  return findings.filter((_finding, index) => !embargoedIndexes.has(index));
}

function redactFindingIdsForPublicDisclosure(
  findingIds: string[],
  embargoedIndexes: ReadonlySet<number>,
): string[] {
  if (embargoedIndexes.size === 0) return findingIds;
  return findingIds.filter((_findingId, index) => !embargoedIndexes.has(index));
}

// Install-only lane: onboarder summary, patch agent, PR comment, click-
// apply review comments, patch decisions persistence. Lives inside the
// kernel module (audit T2.3) so the install path stays a single kernel
// invocation; paid rails leave `installLane` undefined and skip this.
async function runInstallLane(args: {
  reviewId: string;
  owner: string;
  repo: string;
  prNumber: number;
  bundle: Awaited<ReturnType<typeof realReviewPR>>;
  files: Parameters<typeof realReviewPR>[0]["files"];
  findingIds: string[];
  reviewAttempt: number;
  evidenceBundleEnabled: boolean;
  embargoedDisclosureIndexes: ReadonlySet<number>;
  lane: ReviewKernelInstallLane;
}): Promise<void> {
  const {
    reviewId,
    owner,
    repo,
    prNumber,
    bundle,
    files,
    findingIds,
    reviewAttempt,
    evidenceBundleEnabled,
    embargoedDisclosureIndexes,
    lane,
  } = args;

  if (embargoedDisclosureIndexes.size === 0) {
    // Onboarder summary fires regardless of agreed/degraded. It self-gates
    // on ONBOARDER_ENABLED + first-review-only. Failures are logged but
    // never bubble; the review itself is the load-bearing outcome.
    try {
      const perProviderFindingCounts: Record<string, number> = {};
      for (const p of bundle.perProvider) {
        perProviderFindingCounts[p.name] = p.output?.findings.length ?? 0;
      }
      await lane.runFirstReviewSummary({
        installationId: lane.installationId,
        owner,
        repo,
        prNumber,
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
  } else {
    logInfo("disclosure.first_review_summary_suppressed", {
      reviewId,
      withheldFindings: embargoedDisclosureIndexes.size,
    });
  }

  if (bundle.degraded || bundle.agreed.length === 0) return;
  const publicAgreed = publicAgreedFindings(bundle.agreed, embargoedDisclosureIndexes);
  if (publicAgreed.length === 0) {
    logInfo("disclosure.public_comment_suppressed", {
      reviewId,
      withheldFindings: embargoedDisclosureIndexes.size,
    });
    return;
  }

  // Patch Agent v1.5 — between agreement gate and comment post. Returns
  // null when the env flag is disabled OR when the per-install override
  // is false (PR6); in those cases the worker proceeds findings-only.
  // A throw here is logged but never blocks comment posting — the spec
  // requires patch generation failure to be invisible to the caller.
  let patchOutcome: Awaited<ReturnType<typeof realRunPatchAgent>> = null;
  if (embargoedDisclosureIndexes.size === 0) {
    try {
      patchOutcome = await lane.runPatchAgent({
        reviewId,
        installationId: lane.installationId,
        repo,
        findings: bundle.agreed,
        changedFiles: files,
      });
    } catch (err) {
      logError("patch_agent.threw", {
        reviewId,
        message: messageOf(err),
      });
    }
  } else {
    logInfo("disclosure.patch_agent_suppressed", {
      reviewId,
      withheldFindings: embargoedDisclosureIndexes.size,
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

  // Daybreak — patch verifier. Runs AFTER the patch agent produces
  // proposals and BEFORE we persist / post them. Drops `regressed`
  // patches outright; tags `inconclusive` ones so the suggestion block
  // can mark them unverified. `verified` patches pass through unchanged.
  //
  // The verifier needs git+spawn+/tmp. Serverless runtimes will return
  // `inconclusive` on every entry (no-clone path), which is the correct
  // direction — we keep posting the suggestion but mark it unverified.
  // Throws never block the post; we log and continue.
  if (patchOutcome !== null && patchOutcome.byIndex.size > 0) {
    try {
      const enabled = await lane.isPatchVerifyEnabledForInstall(lane.installationId, repo);
      if (enabled) {
        const applied = await lane.applyPatchVerifier({
          outcome: patchOutcome,
          repoUrl: `https://github.com/${owner}/${repo}.git`,
          sha: lane.commitSha,
          findingAt: (i) => bundle.agreed[i],
          findingIdAt: (i) => findingIds[i] ?? null,
          io: realPatchVerifierIo(),
        });
        for (const row of applied.rows) {
          let gateOutcomeId: string | null = null;
          try {
            gateOutcomeId = await lane.recordGateOutcome(reviewId, {
              findingId: row.findingId,
              stage: "patch_verify",
              verdict: row.outcome.verdict,
              evidence: row.outcome,
              modelId: null,
              reviewAttempt,
            });
          } catch (persistErr) {
            logError("patch_verify.persist_failed", {
              reviewId,
              message: messageOf(persistErr),
            });
          }
          if (evidenceBundleEnabled && row.findingId !== null && gateOutcomeId !== null) {
            const slots = patchVerifyEvidenceSlots({
              finding: bundle.agreed[row.index],
              outcome: row.outcome,
              sourceGateOutcomeId: gateOutcomeId,
              reviewerModelIds: bundle.modelIds,
              reviewedSha: lane.commitSha,
              reviewAttempt,
            });
            if (slots.pocSnippet !== null || slots.reproductionCommand !== null) {
              try {
                await lane.recordFindingEvidenceBundleSlot({
                  reviewId,
                  findingId: row.findingId,
                  reviewAttempt,
                  affectedSha: lane.commitSha,
                  pocSnippet: slots.pocSnippet,
                  reproductionCommand: slots.reproductionCommand,
                });
              } catch (persistErr) {
                logError("evidence_bundle.patch_verify_persist_failed", {
                  reviewId,
                  findingId: row.findingId,
                  message: messageOf(persistErr),
                });
              }
            }
          }
        }
        if (applied.droppedIndexes.length > 0) {
          logInfo("patch_verify.regressed_dropped", {
            reviewId,
            droppedIndexes: applied.droppedIndexes,
          });
        }
        logInfo("patch_verify.completed", {
          reviewId,
          verified: applied.rows.filter((r) => r.outcome.verdict === "verified").length,
          regressed: applied.rows.filter((r) => r.outcome.verdict === "regressed").length,
          inconclusive: applied.rows.filter((r) => r.outcome.verdict === "inconclusive").length,
        });
      }
    } catch (err) {
      logError("patch_verify.threw", {
        reviewId,
        message: messageOf(err),
      });
    }
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
      clickApplyEnabled = await lane.isPatchAgentClickApplyEnabledForInstall(
        lane.installationId,
        repo,
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
    settlement = await lane.loadReviewSettlement(reviewId);
  } catch (err) {
    logError("review_worker.settlement_lookup_failed", {
      reviewId,
      message: messageOf(err),
    });
  }
  const commentBody = formatPRComment(publicAgreed, {
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
  // findingIds were already written by the kernel above. The install
  // lane consumes the same array for canonical-id translation below.
  const posted = await lane.postPRComment({
    installationId: lane.installationId,
    owner,
    repo,
    prNumber,
    body: commentBody,
  });
  logInfo("comment.posted", {
    reviewId,
    commentId: posted.id,
    commentUrl: posted.htmlUrl,
    findingCount: publicAgreed.length,
    patchesIncluded: patchOutcome?.byIndex.size ?? 0,
  });

  await lane.setReviewComment({
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
  //
  // patch-agent generates its own finding_id strings via makeFindingId
  // (always the round-5+ long form). recordFindingStatuses, on retry of
  // a pre-deploy review, intentionally preserves the existing short
  // finding_id text. Translate the patch-decision's finding_id through
  // findingIds[index] so the WHERE finding_id = X clause in
  // recordPatchDecisions / recordPatchProposedEvent / etc. matches the
  // actual finding_status row even when its id is legacy short form.
  const canonicalFindingId = (decisionFindingId: string): string => {
    const m = /-(\d+)$/.exec(decisionFindingId);
    if (m === null) return decisionFindingId;
    const index = Number(m[1]);
    return findingIds[index] ?? decisionFindingId;
  };
  if (patchOutcome !== null && patchOutcome.decisions.length > 0) {
    try {
      await lane.recordPatchDecisions(
        patchOutcome.decisions.map((d) => {
          // runPatchAgent always populates tokensByFindingId (every return
          // path sets a Map); the `?.` only tolerates loosely-typed test mocks
          // that omit the field. A missing split → all-null token columns.
          const split = patchOutcome.tokensByFindingId?.get(d.findingId);
          return {
            findingId: canonicalFindingId(d.findingId),
            suggestedPatch: d.patch,
            patchModelId: d.modelId,
            patchSkipReason: d.gateOutcome,
            proposedAt: lane.now(),
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
      await lane.setReviewPatchCost(reviewId, patchOutcome.costPatchUsd);

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
          // Canonical id from recordFindingStatuses (preserves legacy
          // short-form text on retry of a pre-deploy review).
          const findingId = findingIds[findingIndex] ?? makeFindingId(reviewId, findingIndex);
          try {
            const reviewCommentPost = await lane.postPatchReviewComment({
              installationId: lane.installationId,
              owner,
              repo,
              pullNumber: prNumber,
              commitId: lane.commitSha,
              path: ev.path,
              line: ev.startLine,
              patch,
              bodyPrefix: `**${finding.title}** · proposed patch (model: \`${patch.modelId}\`)`,
            });
            if (reviewCommentPost === null) continue;
            await lane.recordPatchReviewComment({
              findingId,
              reviewCommentId: reviewCommentPost.id,
              reviewCommentUrl: reviewCommentPost.url,
              proposedAt: lane.now(),
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
        const canonicalId = canonicalFindingId(d.findingId);
        const linkedComment = reviewCommentByFindingId.get(canonicalId);
        await lane.recordPatchProposedEvent({
          installationId: lane.installationId,
          owner,
          repo,
          reviewId,
          findingId: canonicalId,
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
}

// Inner review work for the installation rail. After audit T2.3 this is
// a thin wrapper around `runReviewKernel`: it fetches files using the
// install-token client, then invokes the kernel with the install-only
// lane (onboarder + patch agent + PR comment + click-apply) wired
// through. Any throw bubbles up to runReviewWorker's catch where retry
// decisions are made.
async function processClaimedRow(
  reviewId: string,
  row: ReviewQueueRow & { installationId: number; owner: string; repo: string },
  deps: WorkerDeps,
  reviewAttempt: number,
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

  let threatModelSnapshot: RepoThreatModelSnapshot | null | undefined;
  try {
    const threatModelEnabled = await deps.isThreatModelEnabledForInstall(
      row.installationId,
      row.repo,
    );
    if (threatModelEnabled) {
      threatModelSnapshot = await deps.getRepoThreatModelFiles({
        installationToken,
        owner: row.owner,
        repo: row.repo,
        sha: row.commitSha,
      });
      logInfo("repo_threat_model.files_fetched", {
        reviewId,
        fileCount: threatModelSnapshot.files.length,
        pathCount: threatModelSnapshot.paths.length,
      });
    }
  } catch (err) {
    threatModelSnapshot = null;
    logError("repo_threat_model.files_fetch_failed", {
      reviewId,
      message: messageOf(err),
    });
  }

  const kernelOutcome = await runReviewKernel(
    {
      reviewId,
      repoHash: row.repoHash,
      owner: row.owner,
      repo: row.repo,
      prNumber: row.prNumber,
      commitSha: row.commitSha,
      publicReceipt: row.publicReceipt,
      files,
      threatModelSnapshot,
      // No cost cap on the installation rail — drawdown lives in the
      // paywall layer, not here.
      // No signal — the installation rail has no wall-clock budget.
      reviewAttempt,
      installLane: {
        installationId: row.installationId,
        commitSha: row.commitSha,
        runFirstReviewSummary: deps.runFirstReviewSummary,
        runPatchAgent: deps.runPatchAgent,
        isPatchAgentClickApplyEnabledForInstall: deps.isPatchAgentClickApplyEnabledForInstall,
        postPatchReviewComment: deps.postPatchReviewComment,
        recordPatchReviewComment: deps.recordPatchReviewComment,
        loadReviewSettlement: deps.loadReviewSettlement,
        postPRComment: deps.postPRComment,
        setReviewComment: deps.setReviewComment,
        recordPatchDecisions: deps.recordPatchDecisions,
        setReviewPatchCost: deps.setReviewPatchCost,
        recordPatchProposedEvent: deps.recordPatchProposedEvent,
        applyPatchVerifier: deps.applyPatchVerifier,
        recordGateOutcome: deps.recordGateOutcome,
        recordFindingEvidenceBundleSlot: deps.recordFindingEvidenceBundleSlot,
        isPatchVerifyEnabledForInstall: deps.isPatchVerifyEnabledForInstall,
        now: deps.now,
      },
    },
    {
      reviewPR: deps.reviewPR,
      updateReview: deps.updateReview,
      recordFindingStatuses: deps.recordFindingStatuses,
      loadRepoThreatModel: deps.loadRepoThreatModel,
      upsertRepoThreatModel: deps.upsertRepoThreatModel,
      applyReachabilityGate: deps.applyReachabilityGate,
      recordGateOutcome: deps.recordGateOutcome,
      recordFindingEvidenceBundleSlot: deps.recordFindingEvidenceBundleSlot,
      initializeDisclosureForFindings: deps.initializeDisclosureForFindings,
      isReachabilityGateEnabledForInstall: deps.isReachabilityGateEnabledForInstall,
      isThreatModelEnabledForInstall: deps.isThreatModelEnabledForInstall,
      isEvidenceBundleEnabledForInstall: deps.isEvidenceBundleEnabledForInstall,
      isDisclosureGateEnabledForInstall: deps.isDisclosureGateEnabledForInstall,
      isDisclosureSideTableEnabled: deps.isDisclosureSideTableEnabled,
      getRepoCyberTier: deps.getRepoCyberTier,
    },
  );
  if (kernelOutcome.kind === "skipped") return;

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

export async function realGetRepoThreatModelFiles(args: {
  installationToken: string;
  owner: string;
  repo: string;
  sha: string;
}): Promise<RepoThreatModelSnapshot> {
  return getRepoThreatModelFilesWith(makeOctokitForInstall(args.installationToken), {
    owner: args.owner,
    repo: args.repo,
    sha: args.sha,
  });
}

// Octokit instance helper — symmetric with the webhook handler's use of
// the installation token for repo-visibility checks. Exposed so callers
// outside this module can construct one without re-deriving the auth.
export function makeOctokitForInstall(installationToken: string): Octokit {
  return new Octokit({ auth: installationToken });
}

function storedThreatModelPublicAccess(value: string): ThreatModelPublicAccess {
  if (value === "public" || value === "live_protocol_review_required" || value === "private") {
    return value;
  }
  return "private";
}
