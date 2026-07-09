// Async review job worker. Picks up a review_jobs row, runs the review
// pipeline, persists the result, and triggers refund on automated failures.
// Called both by waitUntil() (primary) and the safety-net cron (backup).

import { db } from "@/db";
import {
  enqueueReview,
  hashRepo,
  markReviewSucceeded,
  recordFindingStatuses,
  recordSingleModelFindingStatuses,
  recordFindingEvidenceBundleSlot,
  recordGateOutcome,
  loadRepoThreatModel,
  loadPrivateDisclosureFindingIndexes,
  updateReview,
  upsertRepoThreatModel,
} from "@/db/queries";
import { initializeDisclosureForFindings } from "@/lib/disclosure";
import { isSingleModelTierEnabledForInstall } from "@/lib/single-model-tier-env";
import { isThirdModelAdjudicationEnabledForInstall } from "@/lib/third-model-adjudication-env";
import { applyThirdModelAdjudication } from "@/lib/third-model-adjudication";
import { getRepoCyberTier } from "@/lib/cyber-tier";
import { applyReachabilityGate } from "@/lib/reachability-gate";
import { getRepoThreatModelFilesWith, type RepoThreatModelSnapshot } from "@/lib/repo-threat-model";
import {
  isCyberTierEnabled,
  isDisclosureGateEnabled,
  isDisclosureGateEnabledForInstall,
  isDisclosureSideTableEnabled,
  isEvidenceBundleEnabledForInstall,
  isReachabilityGateEnabledForInstall,
  isThreatModelEnabledForInstall,
} from "@/lib/daybreak-gates-env";
import { getInstallationToken } from "@/lib/github-app";
import { alertCritical } from "@/lib/alert";
import { logError, logInfo, messageOf } from "@/lib/log";
import {
  getReviewJob,
  markAcpJobReviewLinked,
  markAcpJobSubmitFailed,
  markAcpJobSubmitting,
  markAcpJobSubmitted,
  markJobComplete,
  markJobFailed,
  markJobFailedWithResult,
  markJobRunning,
  markX402JobReviewLinked,
  markX402JobCompleteSettled,
  markX402JobFailedWithResultAndSettlement,
  markX402SettlementFailed,
  markX402SettlementNotSettled,
  markX402SettlementSettled,
  type ReviewJobRow,
} from "@/lib/review-job-queries";
import { isPublicRepo } from "@/lib/repo-visibility";
import { isBenchmarkRepo } from "@/lib/repo-benchmark";
import { runReviewKernel, runReviewWorker } from "@/lib/review-worker";
import {
  getPublicChangedFiles,
  getPublicCommitSnapshotFiles,
  makePublicOctokit,
} from "@/lib/github-files-public";
import { reviewPR } from "@/lib/review-pipeline";
import { getAcpReviewPriceUsdc, getReviewPriceUsdc } from "@/lib/paywall/env";
import {
  readAuthorizationState,
  settlePayment,
  X402PaymentError,
  type X402AuthorizationState,
  type SettlementResult,
} from "@/lib/x402/facilitator";
import { loadX402Config } from "@/lib/x402/env";
import { X402_MAX_TIMEOUT_SECONDS } from "@/lib/x402/env";
import {
  X402_SETTLED_FAILURE_MODES,
  x402FailureMessage,
  x402FailureResultPayload,
} from "@/lib/x402/review-job-result";
import {
  buildAcpReviewDeliverable,
  buildAcpReviewError,
  mapFindingToAcpFinding,
  type AcpReviewDeliverable,
  type AcpReviewErrorCode,
} from "@/lib/acp/review-contract";
import { submitAcpDeliverable } from "@/lib/acp/provider-cli";
import type { ReviewResponsePayload } from "@/lib/paywall/queries";
import {
  refundJobChannelDebit,
  isRefundableFailureMode,
  safeFailureMessage,
} from "@/lib/paywall/refund";
import { Octokit } from "@octokit/rest";

export type JobWorkerOutcome =
  | { kind: "complete"; jobId: string }
  | { kind: "failed"; jobId: string; failureMode: string; failureMessage: string }
  | { kind: "skipped"; jobId: string; reason: string };

export async function processReviewJob(jobId: string): Promise<JobWorkerOutcome> {
  const job = await getReviewJob(db, jobId);
  if (job === null) {
    logError("review_job_worker.job_missing", { jobId });
    return { kind: "skipped", jobId, reason: "job_missing" };
  }

  if (job.status !== "queued") {
    return { kind: "skipped", jobId, reason: `status_is_${job.status}` };
  }

  const claimed = await markJobRunning(db, jobId, new Date());
  if (!claimed) {
    return { kind: "skipped", jobId, reason: "lost_claim_race" };
  }

  logInfo("review_job", { jobId, event: "started", installationId: job.installationId });

  let capturedX402Settlement: SettlementResult | null = null;
  let capturedAcpDeliverable: AcpReviewDeliverable | null = null;
  let capturedAcpSubmission: unknown = null;
  try {
    const result = await runJobPipeline(job);
    if (job.paymentRail === "acp") {
      const deliverable = result as AcpReviewDeliverable;
      const acpJobId = readRequiredAcpJobId(job);
      capturedAcpDeliverable = deliverable;
      const submitClaimed = await markAcpJobSubmitting(db, jobId, deliverable, new Date());
      if (!submitClaimed) {
        return { kind: "skipped", jobId, reason: "acp_submit_not_claimed" };
      }
      const submitted = await submitAcpDeliverable({ acpJobId, deliverable });
      capturedAcpSubmission = submitted.json ?? submitted.stdout;
      await markAcpJobSubmitted(db, jobId, capturedAcpSubmission, new Date());
      const completed = await markJobComplete(db, jobId, deliverable, new Date());
      if (!completed) {
        throw Object.assign(new Error("ACP complete transition was not claimed"), {
          failureModeTag: "provider_error",
        });
      }
    } else if (job.paymentRail === "x402") {
      // Free-vs-paid is decided from the job's server-set `paymentPayloadBase64`
      // (empty for the free lane — see isFreeX402Job), NOT from a live
      // loadX402Config() read. Reading the price at execution time let an
      // operator's mid-flight X402_REVIEW_PRICE_USDC toggle mis-settle in-flight
      // jobs — a paid job settled under a now-zero price would skip capture
      // (revenue lost), and a free job under a now-positive price would attempt
      // to settle an empty payload (audit M3).
      if (isFreeX402Job(job)) {
        await markX402SettlementNotSettled(db, jobId);
        await markJobComplete(db, jobId, result, new Date());
      } else {
        const settlement = await settleX402Job(job, readRequiredAuthorization(job));
        capturedX402Settlement = settlement;
        await markX402SettlementSettled(db, jobId, settlement.response);
        await markX402JobCompleteSettled(db, jobId, result, settlement.response, new Date());
      }
    } else {
      await markJobComplete(db, jobId, result, new Date());
    }
    logInfo("review_job", {
      jobId,
      event: "completed",
      installationId: job.installationId,
    });
    return { kind: "complete", jobId };
  } catch (err) {
    const failureMode = classifyError(err);
    const rawMessage = messageOf(err);
    // Store a static safe message for the public API; log the raw error internally
    const publicMessage = safeFailureMessage(failureMode);

    logError(
      "review_job",
      job.paymentRail === "acp"
        ? {
            jobId,
            event: "failed",
            installationId: job.installationId,
            paymentRail: "acp",
            failureMode,
            message: safeAcpWorkerLogMessage(rawMessage),
          }
        : {
            jobId,
            event: "failed",
            installationId: job.installationId,
            failureMode,
            rawMessage,
          },
    );

    let outcomeFailureMode = failureMode;
    let outcomeFailureMessage = publicMessage;
    if (job.paymentRail === "acp") {
      const acpFailure = await terminalizeAcpJobFailure({
        job,
        jobId,
        failureMode,
        publicMessage,
        rawMessage,
        capturedDeliverable: capturedAcpDeliverable,
        capturedSubmission: capturedAcpSubmission,
      });
      outcomeFailureMode = acpFailure.failureMode;
      outcomeFailureMessage = acpFailure.failureMessage;
    } else if (job.paymentRail === "x402") {
      const x402Failure = await handleX402JobFailure({
        job,
        jobId,
        err,
        failureMode,
        publicMessage,
        capturedSettlement: capturedX402Settlement,
      });
      outcomeFailureMode = x402Failure.failureMode;
      outcomeFailureMessage = x402Failure.failureMessage;
    } else if (isRefundableFailureMode(failureMode)) {
      await markJobFailed(db, jobId, failureMode, publicMessage, new Date());
      try {
        await refundJobChannelDebit(db, jobId);
        logInfo("review_job", { jobId, event: "refunded", installationId: job.installationId });
      } catch (refundErr) {
        logError("review_job_worker.refund_failed", {
          jobId,
          message: messageOf(refundErr),
        });
      }
    } else {
      await markJobFailed(db, jobId, failureMode, publicMessage, new Date());
    }

    // Alert on terminal infrastructure failures only — not user-input errors
    // (those are caller mistakes, not operator-actionable). settlement errors
    // are always terminal, so outcomeFailureMode "internal" covers them.
    if (outcomeFailureMode !== "user_input" && outcomeFailureMode !== "invalid_input") {
      alertCritical("review_job.failed", {
        jobId,
        paymentRail: job.paymentRail ?? "unknown",
        failureMode: outcomeFailureMode,
      });
    }

    return {
      kind: "failed",
      jobId,
      failureMode: outcomeFailureMode,
      failureMessage: outcomeFailureMessage,
    };
  }
}

async function runJobPipeline(job: ReviewJobRow): Promise<unknown> {
  if (job.paymentRail === "acp") {
    return runAcpJobPipeline(job);
  }
  if (job.paymentRail === "x402") {
    return runX402JobPipeline(job);
  }

  if (job.prNumber === null) {
    throw Object.assign(new Error("pr_number is required"), { failureModeTag: "user_input" });
  }

  const owner = job.repoOwner;
  const repo = job.repoName;
  const prNumber = job.prNumber;

  // The job needs a reviews row to drive the existing review-worker pipeline.
  // Reuse enqueueReview for its idempotency on (repo_hash, pr_number, commit_sha).
  // If the job has a sha, use it; otherwise resolve from GitHub.
  let installationIdNum: number;
  try {
    installationIdNum = await resolveInstallationId(job.installationId);
  } catch {
    throw Object.assign(
      new Error(`installation ${job.installationId} not found or has no GitHub install`),
      { failureModeTag: "user_input" },
    );
  }

  let installationToken: string;
  try {
    installationToken = await getInstallationToken(installationIdNum);
  } catch (err) {
    throw Object.assign(new Error(`GitHub auth failed: ${messageOf(err)}`), {
      failureModeTag: "provider_error",
    });
  }

  const octokit = new Octokit({ auth: installationToken });

  let sha = job.sha;
  if (sha === null) {
    try {
      const pr = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      if (pr.data.state !== "open") {
        throw Object.assign(
          new Error(`PR #${prNumber} is ${pr.data.state}; only open PRs can be reviewed`),
          { failureModeTag: "user_input" },
        );
      }
      sha = pr.data.head.sha;
    } catch (err) {
      if ((err as { failureModeTag?: string }).failureModeTag) throw err;
      // GitHub 404 = PR doesn't exist (user_input); 5xx = GitHub outage (provider_error)
      const httpStatus = (err as { status?: number })?.status;
      const mode = httpStatus !== undefined && httpStatus < 500 ? "user_input" : "provider_error";
      throw Object.assign(new Error(`Failed to resolve PR: ${messageOf(err)}`), {
        failureModeTag: mode,
      });
    }
  }

  const repoHash = hashRepo(owner, repo);
  const [publicReceiptCandidate, isBenchmark, cyberTierEffective] = await Promise.all([
    isPublicRepo(octokit as Parameters<typeof isPublicRepo>[0], owner, repo),
    isBenchmarkRepo(octokit as Parameters<typeof isBenchmarkRepo>[0], owner, repo),
    getRepoCyberTier(owner, repo),
  ]);
  // Cyber tier materializes publicReceipt=false at enqueue time on the
  // generic install/API job path too (matches webhook + x402 + acp).
  // (Architect audit pass-3, severity medium, materialization.)
  const publicReceipt = cyberTierEffective === "cyber" ? false : publicReceiptCandidate;

  const enqueued = await enqueueReview({
    repoHash,
    prNumber,
    commitSha: sha,
    filesReviewed: [],
    promptVersion: "spike-v1",
    providerModelIds: {},
    providerResponses: { status: "pending" },
    agreementDecision: { status: "pending" },
    timingMs: 0,
    costEstimatedUsd: 0,
    schemaVersion: 1,
    installationId: installationIdNum,
    owner,
    repo,
    publicReceipt,
    isBenchmark,
  });

  const outcome = await runReviewWorker(enqueued.reviewId, "api");

  if (outcome.kind === "failed") {
    throw Object.assign(new Error(outcome.error), { failureModeTag: "provider_error" });
  }
  if (outcome.kind === "retried") {
    throw Object.assign(new Error(outcome.error), { failureModeTag: "provider_error" });
  }

  // Load the completed review data for the job result
  const { loadReviewForResponse } = await import("@/lib/paywall/queries");
  const payload = await loadReviewForResponse(db, enqueued.reviewId);
  if (payload === null) {
    throw Object.assign(new Error(`review ${enqueued.reviewId} not found after worker run`), {
      failureModeTag: "internal",
    });
  }
  if (payload.processingStatus !== "done") {
    throw Object.assign(
      new Error(
        `review ${enqueued.reviewId} ended ${payload.processingStatus} after worker outcome ${outcome.kind}`,
      ),
      { failureModeTag: "internal" },
    );
  }

  return {
    ...(await redactReviewPayloadForPublicDisclosure(payload)),
    cached: !enqueued.isNew,
  };
}

async function runX402JobPipeline(job: ReviewJobRow): Promise<unknown> {
  if (job.sha === null || job.prNumber === null) {
    throw Object.assign(new Error("x402 jobs require resolved pr_number and sha"), {
      failureModeTag: "user_input",
    });
  }

  const owner = job.repoOwner;
  const repo = job.repoName;
  const prNumber = job.prNumber;
  const sha = job.sha;
  const fleetCommitReview = prNumber === 0;

  const repoHash = hashRepo(owner, repo);
  // Cyber tier materializes publicReceipt=false at enqueue time so paid
  // rails honor the tier even if the visibility filters later miss a
  // surface. Default tier keeps the historic x402 behavior of
  // publicReceipt=true. (Audit pass-1, materialization.)
  const cyberTierEffective = await getRepoCyberTier(owner, repo);
  const publicReceiptForRow = cyberTierEffective !== "cyber";
  const enqueued = await enqueueReview({
    repoHash,
    prNumber,
    commitSha: sha,
    filesReviewed: [],
    promptVersion: "spike-v1",
    providerModelIds: {},
    providerResponses: { status: "pending", rail: "x402" },
    agreementDecision: { status: "pending" },
    timingMs: 0,
    costEstimatedUsd: 0,
    schemaVersion: 1,
    installationId: null,
    owner,
    repo,
    publicReceipt: publicReceiptForRow,
    isBenchmark: false,
  });
  await markX402JobReviewLinked(db, job.jobId, enqueued.reviewId);

  if (!enqueued.isNew) {
    const { loadReviewForResponse } = await import("@/lib/paywall/queries");
    const cached = await loadReviewForResponse(db, enqueued.reviewId);
    if (cached === null) {
      throw Object.assign(new Error(`cached review ${enqueued.reviewId} not found`), {
        failureModeTag: "internal",
      });
    }
    // Only short-circuit when inference actually finished. A pending row from a
    // prior failed/expired x402 job must be re-run, not returned as complete.
    if (cached.processingStatus === "done") {
      return reviewResultPayload(await redactReviewPayloadForPublicDisclosure(cached), true);
    }
    logInfo("review_job.x402_retry_stale_review", {
      jobId: job.jobId,
      reviewId: enqueued.reviewId,
      processingStatus: cached.processingStatus,
    });
  }

  const files = fleetCommitReview
    ? await getPublicCommitSnapshotFiles({ owner, repo, sha })
    : await getPublicChangedFiles({ owner, repo, prNumber, headSha: sha });
  logInfo("review.files_fetched", {
    jobId: job.jobId,
    reviewId: enqueued.reviewId,
    rail: "x402",
    fleetCommitReview,
    fileCount: files.length,
    filenames: files.map((f) => f.filename),
  });
  const threatModelSnapshot = await getPublicRepoThreatModelSnapshot({
    owner,
    repo,
    sha,
    jobId: job.jobId,
    reviewId: enqueued.reviewId,
    rail: "x402",
  });

  // Shared kernel (audit T2.3): same dispatch → reviewPR → persist (with
  // triage) → recordFindingStatuses surface the installation rail uses.
  // The paid wrapper adds the wall-clock signal + cost cap + rail tag.
  await withX402WallClockTimeout(async (signal) => {
    const outcome = await runReviewKernel(
      {
        reviewId: enqueued.reviewId,
        repoHash,
        owner,
        repo,
        prNumber,
        commitSha: sha,
        publicReceipt: publicReceiptForRow,
        files,
        threatModelSnapshot,
        signal,
        rail: "x402",
        costCap: {
          readPriceUsdc: getReviewPriceUsdc,
          errorMessage: "x402 review exceeded inference cost cap",
        },
      },
      {
        reviewPR,
        updateReview,
        recordFindingStatuses,
        recordSingleModelFindingStatuses,
        isSingleModelTierEnabledForInstall,
        isThirdModelAdjudicationEnabledForInstall,
        applyThirdModelAdjudication,
        loadRepoThreatModel,
        upsertRepoThreatModel,
        applyReachabilityGate,
        recordGateOutcome,
        recordFindingEvidenceBundleSlot,
        initializeDisclosureForFindings,
        isReachabilityGateEnabledForInstall,
        isThreatModelEnabledForInstall,
        isEvidenceBundleEnabledForInstall,
        isDisclosureGateEnabledForInstall,
        isDisclosureSideTableEnabled,
        getRepoCyberTier,
      },
    );
    if (outcome.kind === "completed" || outcome.kind === "skipped") {
      await markReviewSucceeded({ reviewId: enqueued.reviewId, now: new Date() });
    }
  });

  const { loadReviewForResponse } = await import("@/lib/paywall/queries");
  const payload = await loadReviewForResponse(db, enqueued.reviewId);
  if (payload === null) {
    throw Object.assign(new Error(`review ${enqueued.reviewId} not found after x402 run`), {
      failureModeTag: "internal",
    });
  }
  return reviewResultPayload(await redactReviewPayloadForPublicDisclosure(payload), false);
}

async function runAcpJobPipeline(job: ReviewJobRow): Promise<AcpReviewDeliverable> {
  const owner = job.repoOwner;
  const repo = job.repoName;
  const target = await resolveAcpReviewTarget(job);
  const repoHash = hashRepo(owner, repo);
  // Cyber tier materializes publicReceipt=false at enqueue time. Mirrors
  // the x402 path. (Audit pass-1, materialization.)
  const cyberTierEffective = await getRepoCyberTier(owner, repo);
  const publicReceiptForRow = cyberTierEffective !== "cyber";
  const enqueued = await enqueueReview({
    repoHash,
    prNumber: target.prNumber,
    commitSha: target.sha,
    filesReviewed: [],
    promptVersion: "spike-v1",
    providerModelIds: {},
    providerResponses: { status: "pending", rail: "acp" },
    agreementDecision: { status: "pending" },
    timingMs: 0,
    costEstimatedUsd: 0,
    schemaVersion: 1,
    installationId: null,
    owner,
    repo,
    publicReceipt: publicReceiptForRow,
    isBenchmark: false,
  });
  await markAcpJobReviewLinked(db, job.jobId, enqueued.reviewId);

  if (!enqueued.isNew) {
    const { loadReviewForResponse } = await import("@/lib/paywall/queries");
    const cached = await loadReviewForResponse(db, enqueued.reviewId);
    if (cached === null) {
      throw Object.assign(new Error(`cached review ${enqueued.reviewId} not found`), {
        failureModeTag: "internal",
      });
    }
    return acpDeliverableFromReviewPayload(
      job,
      await redactReviewPayloadForPublicDisclosure(cached),
    );
  }

  const files = await getPublicChangedFiles({
    owner,
    repo,
    prNumber: target.prNumber,
    headSha: target.sha,
  });
  logInfo("review.files_fetched", {
    jobId: job.jobId,
    reviewId: enqueued.reviewId,
    rail: "acp",
    fileCount: files.length,
    filenames: files.map((f) => f.filename),
  });
  const threatModelSnapshot = await getPublicRepoThreatModelSnapshot({
    owner,
    repo,
    sha: target.sha,
    jobId: job.jobId,
    reviewId: enqueued.reviewId,
    rail: "acp",
  });

  // Shared kernel (audit T2.3). ACP differs from x402 only in how it
  // handles an empty-files outcome: ACP cannot deliver an empty review
  // under the schema contract, so the empty-files branch throws
  // `no_reviewable_files` instead of marking the review succeeded.
  await withX402WallClockTimeout(async (signal) => {
    const outcome = await runReviewKernel(
      {
        reviewId: enqueued.reviewId,
        repoHash,
        owner,
        repo,
        prNumber: target.prNumber,
        commitSha: target.sha,
        publicReceipt: publicReceiptForRow,
        files,
        threatModelSnapshot,
        signal,
        rail: "acp",
        costCap: {
          readPriceUsdc: getAcpReviewPriceUsdc,
          errorMessage: "ACP review exceeded inference cost cap",
        },
      },
      {
        reviewPR,
        updateReview,
        recordFindingStatuses,
        recordSingleModelFindingStatuses,
        isSingleModelTierEnabledForInstall,
        isThirdModelAdjudicationEnabledForInstall,
        applyThirdModelAdjudication,
        loadRepoThreatModel,
        upsertRepoThreatModel,
        applyReachabilityGate,
        recordGateOutcome,
        recordFindingEvidenceBundleSlot,
        initializeDisclosureForFindings,
        isReachabilityGateEnabledForInstall,
        isThreatModelEnabledForInstall,
        isEvidenceBundleEnabledForInstall,
        isDisclosureGateEnabledForInstall,
        isDisclosureSideTableEnabled,
        getRepoCyberTier,
      },
    );
    if (outcome.kind === "skipped") {
      throw Object.assign(new Error("no reviewable files"), {
        failureModeTag: "no_reviewable_files",
      });
    }
    await markReviewSucceeded({ reviewId: enqueued.reviewId, now: new Date() });
  });

  const { loadReviewForResponse } = await import("@/lib/paywall/queries");
  const payload = await loadReviewForResponse(db, enqueued.reviewId);
  if (payload === null) {
    throw Object.assign(new Error(`review ${enqueued.reviewId} not found after ACP run`), {
      failureModeTag: "internal",
    });
  }
  return acpDeliverableFromReviewPayload(
    job,
    await redactReviewPayloadForPublicDisclosure(payload),
  );
}

async function getPublicRepoThreatModelSnapshot(args: {
  owner: string;
  repo: string;
  sha: string;
  jobId: string;
  reviewId: string;
  rail: "x402" | "acp";
}): Promise<RepoThreatModelSnapshot | null | undefined> {
  const enabled = await isThreatModelEnabledForInstall(null, args.repo);
  if (!enabled) return undefined;
  try {
    const snapshot = await getRepoThreatModelFilesWith(makePublicOctokit(), {
      owner: args.owner,
      repo: args.repo,
      sha: args.sha,
    });
    logInfo("repo_threat_model.files_fetched", {
      jobId: args.jobId,
      reviewId: args.reviewId,
      rail: args.rail,
      fileCount: snapshot.files.length,
      pathCount: snapshot.paths.length,
    });
    return snapshot;
  } catch (err) {
    logError("repo_threat_model.files_fetch_failed", {
      jobId: args.jobId,
      reviewId: args.reviewId,
      rail: args.rail,
      message: messageOf(err),
    });
    return null;
  }
}

async function resolveAcpReviewTarget(
  job: ReviewJobRow,
): Promise<{ prNumber: number; sha: string }> {
  const octokit = makePublicOctokit();
  const publicRepo = await isPublicRepo(
    octokit as Parameters<typeof isPublicRepo>[0],
    job.repoOwner,
    job.repoName,
  );
  if (!publicRepo) {
    throw Object.assign(new Error("ACP target repository is not publicly accessible"), {
      failureModeTag: "repo_not_accessible",
    });
  }
  if (job.prNumber !== null) {
    try {
      const pr = await octokit.rest.pulls.get({
        owner: job.repoOwner,
        repo: job.repoName,
        pull_number: job.prNumber,
      });
      if (pr.data.state !== "open") {
        throw Object.assign(new Error(`PR #${job.prNumber} is ${pr.data.state}`), {
          failureModeTag: "pr_not_open",
        });
      }
      return { prNumber: job.prNumber, sha: pr.data.head.sha };
    } catch (err) {
      if ((err as { failureModeTag?: string }).failureModeTag) throw err;
      const status = (err as { status?: number })?.status;
      if (status === 403 || status === 404) {
        throw Object.assign(
          new Error(`ACP target PR is not publicly accessible: ${messageOf(err)}`),
          {
            failureModeTag: "repo_not_accessible",
          },
        );
      }
      throw Object.assign(new Error(`Failed to resolve ACP PR target: ${messageOf(err)}`), {
        failureModeTag: "provider_error",
      });
    }
  }
  if (job.sha === null) {
    throw Object.assign(new Error("ACP job requires target.pr or target.sha"), {
      failureModeTag: "invalid_input",
    });
  }

  const matches: Array<{ prNumber: number; sha: string }> = [];
  try {
    const pulls = await octokit.paginate(octokit.rest.pulls.list, {
      owner: job.repoOwner,
      repo: job.repoName,
      state: "open",
      per_page: 100,
    });
    for (const pr of pulls) {
      if (pr.head.sha.toLowerCase().startsWith(job.sha.toLowerCase())) {
        matches.push({ prNumber: pr.number, sha: pr.head.sha });
      }
    }
  } catch (err) {
    throw Object.assign(new Error(`Failed to resolve ACP SHA target: ${messageOf(err)}`), {
      failureModeTag: "repo_not_accessible",
    });
  }

  if (matches.length === 0) {
    throw Object.assign(new Error("ACP SHA target is not the head of an open PR"), {
      failureModeTag: "sha_not_in_open_pr",
    });
  }
  if (matches.length > 1) {
    throw Object.assign(new Error("ACP SHA target matches multiple open PRs"), {
      failureModeTag: "sha_ambiguous",
    });
  }
  return matches[0] as { prNumber: number; sha: string };
}

function acpDeliverableFromReviewPayload(
  job: ReviewJobRow,
  payload: ReviewResponsePayload,
): AcpReviewDeliverable {
  const agreement = readAgreementDecision(payload.agreementDecision);
  if (agreement.degraded) {
    throw Object.assign(new Error("ACP review degraded below two-model consensus"), {
      failureModeTag: "provider_degraded",
    });
  }
  if (agreement.mode !== "unanimous" && agreement.agreed.length > 0) {
    throw Object.assign(new Error("ACP review did not produce unanimous findings"), {
      failureModeTag: "provider_degraded",
    });
  }
  const reviewReceiptUrl = absoluteAntfleetUrl(`/receipts/review/${payload.reviewId}`);
  return buildAcpReviewDeliverable({
    acpJobId: readRequiredAcpJobId(job),
    antfleetJobId: job.jobId,
    clientAgentWallet: job.acpClientWallet ?? null,
    statusUrl: absoluteAntfleetUrl(`/api/v1/acp/review-jobs/${job.jobId}`),
    target: {
      repo: `${job.repoOwner}/${job.repoName}`,
      pr: payload.prNumber,
      headSha: payload.commitSha,
    },
    review: {
      reviewId: payload.reviewId,
      modelIds: readModelIds(payload.providerModelIds),
      durationMs: payload.timingMs,
    },
    findings: agreement.agreed.map((finding, index) =>
      mapFindingToAcpFinding({
        reviewId: payload.reviewId,
        index,
        findingId: payload.findingIds[index] ?? null,
        finding,
        receiptUrl: null,
      }),
    ),
    reviewReceiptUrl,
    receiptPending: agreement.withheldFindings > 0,
    includeTradingDisclaimer: shouldIncludeAcpTradingDisclaimer(job),
  });
}

function readAgreementDecision(value: unknown): {
  mode: string | null;
  agreed: Parameters<typeof mapFindingToAcpFinding>[0]["finding"][];
  degraded: boolean;
  withheldFindings: number;
} {
  if (typeof value !== "object" || value === null) {
    return { mode: null, agreed: [], degraded: false, withheldFindings: 0 };
  }
  const record = value as Record<string, unknown>;
  const agreed = Array.isArray(record["agreed"])
    ? (record["agreed"] as Parameters<typeof mapFindingToAcpFinding>[0]["finding"][])
    : [];
  const disclosure =
    typeof record["disclosure"] === "object" && record["disclosure"] !== null
      ? (record["disclosure"] as Record<string, unknown>)
      : {};
  const withheldFindings =
    typeof disclosure["withheldFindings"] === "number" &&
    Number.isInteger(disclosure["withheldFindings"])
      ? disclosure["withheldFindings"]
      : 0;
  return {
    mode: typeof record["mode"] === "string" ? record["mode"] : null,
    agreed,
    degraded: record["degraded"] === true,
    withheldFindings,
  };
}

async function redactReviewPayloadForPublicDisclosure(
  payload: ReviewResponsePayload,
): Promise<ReviewResponsePayload> {
  // Gate on the UNION of every policy flag that could write a private
  // disclosure row: the disclosure gate, the side-table backfill flag,
  // and the cyber tier flag. Cyber tier writes embargo rows from
  // `initializeDisclosureForFindings` independent of the disclosure
  // gate (review-worker.ts:1036), so omitting it from this union
  // recreates the pass-5 leak. Including ALL THREE preserves the
  // "byte-identical when all flags off" contract while still redacting
  // whenever any policy is active. (Security audit pass-5 high +
  // architect audit pass-6 medium.)
  if (!isCyberTierEnabled() && !isDisclosureGateEnabled() && !isDisclosureSideTableEnabled()) {
    return payload;
  }
  const privateIndexes = await loadPrivateDisclosureFindingIndexes(payload.reviewId);
  if (privateIndexes.length === 0) return payload;
  const privateIndexSet = new Set(privateIndexes);
  return {
    ...payload,
    agreementDecision: redactAgreementDecision(payload.agreementDecision, privateIndexSet),
    findingIds: payload.findingIds.filter((_findingId, index) => !privateIndexSet.has(index)),
  };
}

function redactAgreementDecision(value: unknown, privateIndexes: ReadonlySet<number>): unknown {
  if (typeof value !== "object" || value === null || privateIndexes.size === 0) return value;
  const record = value as Record<string, unknown>;
  const agreed = Array.isArray(record["agreed"]) ? record["agreed"] : [];
  const publicIndexMap = new Map<number, number>();
  const publicAgreed = agreed.filter((_finding, index) => {
    if (privateIndexes.has(index)) return false;
    publicIndexMap.set(index, publicIndexMap.size);
    return true;
  });
  const reachabilityGate = redactReachabilityGate(
    record["reachabilityGate"],
    privateIndexes,
    publicIndexMap,
  );
  return {
    mode: record["mode"],
    agreed: publicAgreed,
    degraded: record["degraded"] === true,
    ...(typeof record["degradedReason"] === "string" || record["degradedReason"] === null
      ? { degradedReason: record["degradedReason"] }
      : {}),
    ...(record["triage"] !== undefined ? { triage: record["triage"] } : {}),
    ...(reachabilityGate !== undefined ? { reachabilityGate } : {}),
    disclosure: {
      ...(typeof record["disclosure"] === "object" && record["disclosure"] !== null
        ? (record["disclosure"] as Record<string, unknown>)
        : {}),
      withheldFindings: privateIndexes.size,
      reason: "private coordinated disclosure",
    },
  };
}

function redactReachabilityGate(
  value: unknown,
  privateIndexes: ReadonlySet<number>,
  publicIndexMap: ReadonlyMap<number, number>,
): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const downgrades = Array.isArray(record["downgrades"]) ? record["downgrades"] : [];
  const publicDowngrades = downgrades.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const downgrade = entry as Record<string, unknown>;
    const index = downgrade["index"];
    if (typeof index !== "number" || !Number.isInteger(index) || privateIndexes.has(index)) {
      return [];
    }
    const remappedIndex = publicIndexMap.get(index);
    if (remappedIndex === undefined) return [];
    return [
      {
        index: remappedIndex,
        reason: typeof downgrade["reason"] === "string" ? downgrade["reason"] : "redacted",
        ...(typeof downgrade["originalSeverity"] === "string"
          ? { originalSeverity: downgrade["originalSeverity"] }
          : {}),
      },
    ];
  });
  if (publicDowngrades.length === 0) return undefined;
  return { downgrades: publicDowngrades };
}

function readModelIds(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") result[key] = raw;
  }
  return result;
}

function shouldIncludeAcpTradingDisclaimer(job: ReviewJobRow): boolean {
  const request = job.acpRequestPayload;
  if (typeof request !== "object" || request === null) return false;
  const options = (request as { options?: { focus?: unknown } }).options;
  return Array.isArray(options?.focus) && options.focus.includes("trading-risk");
}

function absoluteAntfleetUrl(path: string): string {
  const base =
    process.env["ANTFLEET_PUBLIC_BASE_URL"] ??
    process.env["NEXT_PUBLIC_SITE_URL"] ??
    "https://www.antfleet.dev";
  return new URL(path, base).toString();
}

function readRequiredAcpJobId(job: ReviewJobRow): string {
  if (job.acpJobId === null || job.acpJobId === undefined || job.acpJobId.trim() === "") {
    throw Object.assign(new Error("ACP job id missing from review_jobs row"), {
      failureModeTag: "internal",
    });
  }
  return job.acpJobId;
}

function reviewResultPayload(
  payload: Record<string, unknown>,
  cached: boolean,
): Record<string, unknown> {
  const reviewId = String(payload["reviewId"]);
  return {
    ...payload,
    cached,
    paid_via: "x402",
    receipt_url: `/receipts/review/${reviewId}`,
  };
}

export async function terminalizeAcpJobFailure(args: {
  job: ReviewJobRow;
  jobId: string;
  failureMode: string;
  publicMessage: string;
  rawMessage: string;
  capturedDeliverable?: AcpReviewDeliverable | null;
  capturedSubmission?: unknown;
}): Promise<{ failureMode: string; failureMessage: string }> {
  if (args.job.acpSubmitStatus === "submitting" || args.job.acpSubmitStatus === "submitted") {
    return preserveSubmittedOrSubmittingAcpJob(args.jobId, args.job);
  }
  if (args.capturedDeliverable !== null && args.capturedDeliverable !== undefined) {
    const preservedMessage =
      "An internal error occurred after ACP deliverable submission. The ACP submission is preserved.";
    if (args.capturedSubmission !== null && args.capturedSubmission !== undefined) {
      try {
        await markAcpJobSubmitted(db, args.jobId, args.capturedSubmission, new Date());
      } catch (markErr) {
        logError("review_job_worker.acp_submission_preserve_failed", {
          jobId: args.jobId,
          message: messageOf(markErr),
        });
      }
    } else {
      try {
        await markAcpJobSubmitFailed(
          db,
          args.jobId,
          {
            message:
              "ACP success deliverable submission is ambiguous; operator reconciliation required",
            originalFailure: args.rawMessage,
          },
          new Date(),
        );
      } catch (markErr) {
        logError("review_job_worker.acp_submission_ambiguous_mark_failed", {
          jobId: args.jobId,
          message: messageOf(markErr),
        });
      }
    }
    await markJobFailedWithResult(
      db,
      args.jobId,
      "internal",
      preservedMessage,
      args.capturedDeliverable,
      new Date(),
    );
    return { failureMode: "internal", failureMessage: preservedMessage };
  }

  const errorPayload = buildAcpReviewError({
    code: acpErrorCodeForFailureMode(args.failureMode),
    message: args.publicMessage,
    retryable: isTransientAcpFailure(args.failureMode),
    settlement: acpSettlementForFailureMode(args.failureMode),
    details: { antfleet_job_id: args.jobId },
  });
  const submitClaimed = await markAcpJobSubmitting(db, args.jobId, errorPayload, new Date());
  if (!submitClaimed) {
    const current = await getReviewJob(db, args.jobId);
    if (
      current?.paymentRail === "acp" &&
      (current.acpSubmitStatus === "submitting" || current.acpSubmitStatus === "submitted")
    ) {
      return preserveSubmittedOrSubmittingAcpJob(args.jobId, current);
    }
    throw Object.assign(new Error("ACP error deliverable submission was not claimed"), {
      failureModeTag: "provider_error",
    });
  }
  try {
    const submitted = await submitAcpDeliverable({
      acpJobId: readRequiredAcpJobId(args.job),
      deliverable: errorPayload,
    });
    await markAcpJobSubmitted(db, args.jobId, submitted.json ?? submitted.stdout, new Date());
  } catch (submitErr) {
    await markAcpJobSubmitFailed(
      db,
      args.jobId,
      { message: messageOf(submitErr), originalFailure: args.rawMessage },
      new Date(),
    );
  }
  await markJobFailedWithResult(
    db,
    args.jobId,
    args.failureMode,
    args.publicMessage,
    errorPayload,
    new Date(),
  );
  return { failureMode: args.failureMode, failureMessage: args.publicMessage };
}

async function preserveSubmittedOrSubmittingAcpJob(
  jobId: string,
  job: ReviewJobRow,
): Promise<{ failureMode: string; failureMessage: string }> {
  const preservedMessage =
    job.acpSubmitStatus === "submitted"
      ? "ACP deliverable was already submitted. Operator reconciliation is required."
      : "ACP deliverable submission is already in progress. Operator reconciliation is required.";
  await markJobFailedWithResult(
    db,
    jobId,
    "internal",
    preservedMessage,
    submittedOrSubmittingAcpDeliverable(job.acpSubmitResponse),
    new Date(),
  );
  return { failureMode: "internal", failureMessage: preservedMessage };
}

function submittedOrSubmittingAcpDeliverable(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return record["deliverable"] ?? value;
}

function safeAcpWorkerLogMessage(message: string): string {
  const lower = message.toLowerCase();
  if (
    lower.includes("stdout") ||
    lower.includes("stderr") ||
    lower.includes("--deliverable") ||
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("private") ||
    lower.includes("authorization")
  ) {
    return "ACP worker failed; details redacted";
  }
  return message.slice(0, 200);
}

function acpErrorCodeForFailureMode(failureMode: string): AcpReviewErrorCode {
  switch (failureMode) {
    case "invalid_input":
    case "user_input":
      return "invalid_input";
    case "repo_not_accessible":
      return "repo_not_accessible";
    case "pr_not_found":
      return "pr_not_found";
    case "pr_not_open":
      return "pr_not_open";
    case "sha_not_in_open_pr":
      return "sha_not_in_open_pr";
    case "sha_ambiguous":
      return "sha_ambiguous";
    case "no_reviewable_files":
      return "no_reviewable_files";
    case "cost_cap_exceeded":
      return "cost_cap_exceeded";
    case "timeout":
      return "timeout";
    case "provider_degraded":
      return "provider_degraded";
    case "provider_error":
      return "provider_error";
    default:
      return "internal";
  }
}

function isTransientAcpFailure(failureMode: string): boolean {
  return ["provider_error", "provider_degraded", "timeout", "internal"].includes(failureMode);
}

function acpSettlementForFailureMode(
  failureMode: string,
): ReturnType<typeof buildAcpReviewError>["error"]["settlement"] {
  if (failureMode === "invalid_input" || failureMode === "user_input") return "not_charged";
  if (failureMode === "internal") return "operator_review";
  return "escrow_refundable";
}

async function settleX402Job(
  job: ReviewJobRow,
  authorization: X402AuthorizationState,
): Promise<SettlementResult> {
  const config = loadX402Config();
  try {
    return await settlePayment({ job, config, authorization, now: new Date() });
  } catch (err) {
    throw tagX402SettlementFailure(err);
  }
}

// True when the job was enqueued through the free ($0) x402 lane. The
// discriminator MUST be a server-authoritative field, not caller-supplied JSON:
// the free lane's `makeFreeAuthorizationState` sets `paymentPayloadBase64` to the
// empty string, while the paid lane stores the caller's non-empty base64
// PAYMENT-SIGNATURE (which an empty value could never pass /verify to obtain). We
// deliberately do NOT key on the inner `paymentPayload.kind`, because that object
// is the verbatim caller payload — the EIP-3009 signature only binds the nested
// `authorization` struct, so a paying caller could inject a sibling
// `kind:"free_trial"` and skip capture (revenue bypass). This is an immutable,
// per-job signal set at enqueue, so the worker never re-reads the live price
// config to decide whether to settle (audit M3).
function isFreeX402Job(job: ReviewJobRow): boolean {
  const authorization = readAuthorizationState(job.x402PaymentPayload);
  return authorization !== null && authorization.paymentPayloadBase64 === "";
}

function readRequiredAuthorization(job: ReviewJobRow): X402AuthorizationState {
  const authorization = readAuthorizationState(job.x402PaymentPayload);
  if (authorization === null) {
    throw Object.assign(new Error("x402 authorization missing from job"), {
      failureModeTag: "internal",
    });
  }
  return authorization;
}

function shouldSettleX402Failure(failureMode: string): boolean {
  return X402_SETTLED_FAILURE_MODES.has(failureMode);
}

async function handleX402JobFailure(args: {
  job: ReviewJobRow;
  jobId: string;
  err: unknown;
  failureMode: string;
  publicMessage: string;
  capturedSettlement?: SettlementResult | null;
}): Promise<{ failureMode: string; failureMessage: string }> {
  const latestJob = (await getReviewJob(db, args.jobId)) ?? args.job;
  let failureMode = args.failureMode;
  let publicMessage = args.publicMessage;
  let settlementStatus: "settled" | "not_settled" | "settlement_failed" =
    latestJob.x402SettlementStatus === "settled" ||
    latestJob.x402SettlementStatus === "settlement_failed"
      ? latestJob.x402SettlementStatus
      : "not_settled";
  let settlementResponse: unknown = latestJob.x402SettlementResponse ?? null;

  if (settlementStatus === "settled") {
    failureMode = "internal";
    publicMessage = x402FailureMessage(failureMode, settlementStatus);
  } else if (settlementStatus === "settlement_failed") {
    failureMode = "internal";
    publicMessage = x402FailureMessage(failureMode, settlementStatus);
  } else if (args.capturedSettlement?.settled === true) {
    failureMode = "internal";
    settlementStatus = "settled";
    settlementResponse = args.capturedSettlement.response;
    publicMessage = x402FailureMessage(failureMode, settlementStatus);
    try {
      await markX402SettlementSettled(db, args.jobId, settlementResponse);
    } catch (markErr) {
      logError("review_job_worker.x402_settlement_preserve_failed", {
        jobId: args.jobId,
        message: messageOf(markErr),
      });
    }
  } else if (args.err instanceof X402PaymentError || isX402SettlementFailure(args.err)) {
    failureMode = "internal";
    settlementStatus = "settlement_failed";
    publicMessage = x402FailureMessage(failureMode, settlementStatus);
    settlementResponse = {
      code: args.err instanceof X402PaymentError ? args.err.code : "x402_settle_failed",
      message: messageOf(args.err),
    };
    await markX402SettlementFailed(db, args.jobId, settlementResponse);
  } else if (shouldSettleX402Failure(failureMode) && !isFreeX402Job(latestJob)) {
    try {
      const settlement = await settleX402Job(latestJob, readRequiredAuthorization(latestJob));
      settlementStatus = "settled";
      settlementResponse = settlement.response;
      await markX402SettlementSettled(db, args.jobId, settlement.response);
      logInfo("review_job", { jobId: args.jobId, event: "x402_settled_failed", failureMode });
    } catch (settleErr) {
      failureMode = "internal";
      settlementStatus = "settlement_failed";
      publicMessage = x402FailureMessage(failureMode, settlementStatus);
      settlementResponse = {
        code: settleErr instanceof X402PaymentError ? settleErr.code : "x402_settle_failed",
        message: messageOf(settleErr),
      };
      await markX402SettlementFailed(db, args.jobId, settlementResponse);
      logError("review_job_worker.x402_settle_failed", {
        jobId: args.jobId,
        failureMode: args.failureMode,
        message: messageOf(settleErr),
      });
    }
  } else {
    await markX402SettlementNotSettled(db, args.jobId);
    publicMessage = x402FailureMessage(failureMode, settlementStatus);
  }

  await markX402JobFailedWithResultAndSettlement(
    db,
    args.jobId,
    failureMode,
    publicMessage,
    x402FailureResultPayload(latestJob, settlementStatus),
    settlementStatus,
    settlementResponse,
    new Date(),
  );
  return { failureMode, failureMessage: publicMessage };
}

function tagX402SettlementFailure(err: unknown): Error & { x402SettlementFailure: true } {
  const error = err instanceof Error ? err : new Error(String(err));
  return Object.assign(error, { x402SettlementFailure: true as const });
}

function isX402SettlementFailure(err: unknown): boolean {
  return Boolean((err as { x402SettlementFailure?: boolean })?.x402SettlementFailure);
}

class WallClockTimeoutError extends Error {
  constructor(timeoutSeconds: number) {
    super(`reviewPR exceeded ${timeoutSeconds}s wall-clock timeout`);
    this.name = "WallClockTimeoutError";
    Object.assign(this, { failureModeTag: "timeout" });
  }
}

async function withX402WallClockTimeout<T>(start: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeoutSeconds = readX402TimeoutSeconds();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeoutError: WallClockTimeoutError | undefined;
  const work = start(controller.signal);
  work.catch(() => undefined);
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timeoutError = new WallClockTimeoutError(timeoutSeconds);
          controller.abort(timeoutError);
          reject(timeoutError);
        }, timeoutSeconds * 1000);
      }),
    ]);
  } catch (err) {
    if (timeoutError !== undefined && controller.signal.aborted) throw timeoutError;
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function readX402TimeoutSeconds(): number {
  const raw = process.env["X402_MAX_TIMEOUT_SECONDS"];
  if (raw === undefined || raw.trim() === "") return X402_MAX_TIMEOUT_SECONDS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : X402_MAX_TIMEOUT_SECONDS;
}

async function resolveInstallationId(installationRowId: string): Promise<number> {
  const { loadPaywallInstallation } = await import("@/lib/paywall/queries");
  const install = await loadPaywallInstallation(db, installationRowId);
  if (install === null || install.installationId === null) {
    throw new Error("installation not found or has no GitHub install");
  }
  return install.installationId;
}

// Classify errors into the failure_mode taxonomy.
// Errors can carry a failureModeTag property set by the pipeline.
function classifyError(err: unknown): string {
  const tagged = (err as { failureModeTag?: string })?.failureModeTag;
  if (tagged) return tagged;

  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();

  if (message.includes("timeout") || message.includes("timed out") || message.includes("aborted")) {
    return "timeout";
  }
  if (
    message.includes("429") ||
    message.includes("rate limit") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    message.includes("fetch failed")
  ) {
    return "provider_error";
  }
  if (
    message.includes("not found") ||
    message.includes("not open") ||
    message.includes("invalid")
  ) {
    return "user_input";
  }
  return "internal";
}
