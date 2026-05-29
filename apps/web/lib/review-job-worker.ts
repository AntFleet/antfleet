// Async review job worker. Picks up a review_jobs row, runs the review
// pipeline, persists the result, and triggers refund on automated failures.
// Called both by waitUntil() (primary) and the safety-net cron (backup).

import { db } from "@/db";
import {
  enqueueReview,
  hashRepo,
  markReviewSucceeded,
  recordFindingStatuses,
  updateReview,
} from "@/db/queries";
import { getInstallationToken } from "@/lib/github-app";
import { logError, logInfo, messageOf } from "@/lib/log";
import {
  getReviewJob,
  markJobComplete,
  markJobFailed,
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
import { runReviewWorker } from "@/lib/review-worker";
import { getPublicChangedFiles } from "@/lib/github-files-public";
import { reviewPR } from "@/lib/review-pipeline";
import { getReviewPriceUsdc } from "@/lib/paywall/env";
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

  try {
    const result = await runJobPipeline(job);
    if (job.paymentRail === "x402") {
      const settlement = await settleX402Job(job, readRequiredAuthorization(job));
      await markX402JobCompleteSettled(db, jobId, result, settlement.response, new Date());
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

    logError("review_job", {
      jobId,
      event: "failed",
      installationId: job.installationId,
      failureMode,
      rawMessage,
    });

    let outcomeFailureMode = failureMode;
    let outcomeFailureMessage = publicMessage;
    if (job.paymentRail === "x402") {
      const x402Failure = await handleX402JobFailure({
        job,
        jobId,
        err,
        failureMode,
        publicMessage,
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

    return {
      kind: "failed",
      jobId,
      failureMode: outcomeFailureMode,
      failureMessage: outcomeFailureMessage,
    };
  }
}

async function runJobPipeline(job: ReviewJobRow): Promise<unknown> {
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
  const [publicReceipt, isBenchmark] = await Promise.all([
    isPublicRepo(octokit as Parameters<typeof isPublicRepo>[0], owner, repo),
    isBenchmarkRepo(octokit as Parameters<typeof isBenchmarkRepo>[0], owner, repo),
  ]);

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
    ...payload,
    cached: !enqueued.isNew,
  };
}

async function runX402JobPipeline(job: ReviewJobRow): Promise<unknown> {
  if (job.prNumber === null || job.sha === null) {
    throw Object.assign(new Error("x402 jobs require resolved pr_number and sha"), {
      failureModeTag: "user_input",
    });
  }

  const owner = job.repoOwner;
  const repo = job.repoName;
  const prNumber = job.prNumber;
  const sha = job.sha;

  const repoHash = hashRepo(owner, repo);
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
    publicReceipt: true,
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
    return reviewResultPayload(cached, true);
  }

  const files = await getPublicChangedFiles({ owner, repo, prNumber, headSha: sha });
  logInfo("review.files_fetched", {
    jobId: job.jobId,
    reviewId: enqueued.reviewId,
    rail: "x402",
    fileCount: files.length,
    filenames: files.map((f) => f.filename),
  });

  if (files.length === 0) {
    await updateReview(enqueued.reviewId, {
      filesReviewed: [],
      providerResponses: { status: "skipped", reason: "no reviewable files", rail: "x402" },
      agreementDecision: { status: "skipped" },
    });
    await markReviewSucceeded({ reviewId: enqueued.reviewId, now: new Date() });
  } else {
    const bundle = await withX402WallClockTimeout(reviewPR({ files, owner, repo, prNumber }));
    const price = Number(getReviewPriceUsdc());
    if (Number.isFinite(price) && bundle.estimatedCostUsd > price * 3) {
      await updateReview(enqueued.reviewId, {
        filesReviewed: files.map((f) => f.filename),
        providerModelIds: bundle.modelIds,
        providerResponses: { perProvider: bundle.perProvider, rail: "x402" },
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
      throw Object.assign(new Error("x402 review exceeded inference cost cap"), {
        failureModeTag: "cost_cap_exceeded",
      });
    }

    await updateReview(enqueued.reviewId, {
      filesReviewed: files.map((f) => f.filename),
      providerModelIds: bundle.modelIds,
      providerResponses: { perProvider: bundle.perProvider, rail: "x402" },
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
    if (!bundle.degraded && bundle.agreed.length > 0) {
      await recordFindingStatuses(
        enqueued.reviewId,
        bundle.agreed.map((f) => ({
          title: f.title,
          severity: f.severity,
          category: f.category,
        })),
      );
    }
    await markReviewSucceeded({ reviewId: enqueued.reviewId, now: new Date() });
  }

  const { loadReviewForResponse } = await import("@/lib/paywall/queries");
  const payload = await loadReviewForResponse(db, enqueued.reviewId);
  if (payload === null) {
    throw Object.assign(new Error(`review ${enqueued.reviewId} not found after x402 run`), {
      failureModeTag: "internal",
    });
  }
  return reviewResultPayload(payload, false);
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
  } else if (args.err instanceof X402PaymentError || isX402SettlementFailure(args.err)) {
    failureMode = "internal";
    settlementStatus = "settlement_failed";
    publicMessage = x402FailureMessage(failureMode, settlementStatus);
    settlementResponse = {
      code: args.err instanceof X402PaymentError ? args.err.code : "x402_settle_failed",
      message: messageOf(args.err),
    };
    await markX402SettlementFailed(db, args.jobId, settlementResponse);
  } else if (shouldSettleX402Failure(failureMode)) {
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

async function withX402WallClockTimeout<T>(work: Promise<T>): Promise<T> {
  const timeoutSeconds = readX402TimeoutSeconds();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new WallClockTimeoutError(timeoutSeconds)),
          timeoutSeconds * 1000,
        );
      }),
    ]);
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
