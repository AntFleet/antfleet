// Async review job worker. Picks up a review_jobs row, runs the review
// pipeline, persists the result, and triggers refund on automated failures.
// Called both by waitUntil() (primary) and the safety-net cron (backup).

import { db } from "@/db";
import { enqueueReview, hashRepo } from "@/db/queries";
import { getInstallationToken } from "@/lib/github-app";
import { logError, logInfo, messageOf } from "@/lib/log";
import {
  getReviewJob,
  markJobComplete,
  markJobFailed,
  markJobRunning,
  type ReviewJobRow,
} from "@/lib/review-job-queries";
import { isPublicRepo } from "@/lib/repo-visibility";
import { isBenchmarkRepo } from "@/lib/repo-benchmark";
import { runReviewWorker } from "@/lib/review-worker";
import { refundJobChannelDebit, isRefundableFailureMode, safeFailureMessage } from "@/lib/paywall/refund";
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
    await markJobComplete(db, jobId, result, new Date());
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
    await markJobFailed(db, jobId, failureMode, publicMessage, new Date());

    logError("review_job", {
      jobId,
      event: "failed",
      installationId: job.installationId,
      failureMode,
      rawMessage,
    });

    if (isRefundableFailureMode(failureMode)) {
      try {
        await refundJobChannelDebit(db, jobId);
        logInfo("review_job", { jobId, event: "refunded", installationId: job.installationId });
      } catch (refundErr) {
        logError("review_job_worker.refund_failed", {
          jobId,
          message: messageOf(refundErr),
        });
      }
    }

    return { kind: "failed", jobId, failureMode, failureMessage: publicMessage };
  }
}

async function runJobPipeline(job: ReviewJobRow): Promise<unknown> {
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
    throw Object.assign(
      new Error(`GitHub auth failed: ${messageOf(err)}`),
      { failureModeTag: "provider_error" },
    );
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
      throw Object.assign(
        new Error(`Failed to resolve PR: ${messageOf(err)}`),
        { failureModeTag: mode },
      );
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
    throw Object.assign(
      new Error(outcome.error),
      { failureModeTag: "provider_error" },
    );
  }

  // Load the completed review data for the job result
  const { loadReviewForResponse } = await import("@/lib/paywall/queries");
  const payload = await loadReviewForResponse(db, enqueued.reviewId);

  return {
    reviewId: enqueued.reviewId,
    cached: !enqueued.isNew,
    ...payload,
  };
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
  if (message.includes("not found") || message.includes("not open") || message.includes("invalid")) {
    return "user_input";
  }
  return "internal";
}

