// GET /api/cron/review-jobs — safety-net cron for orphan/stuck review jobs.
//
// Runs every minute. Three sweeps:
//   1. Orphan pickup: status='queued' older than 60s — waitUntil() didn't fire.
//      Re-triggers the worker.
//   2. Stuck timeout: status='running' with started_at older than 600s (10 min).
//      Marks failed (failure_mode='timeout') and triggers refund.
//   3. Expired cleanup: expires_at < now(). Purges result JSON to save storage;
//      metadata kept for audit.

import type { NextRequest } from "next/server";
import { after, NextResponse } from "next/server";
import { db } from "@/db";
import { requireCronAuth } from "@/lib/cron-auth";
import { logError, logInfo, messageOf } from "@/lib/log";
import {
  findStaleQueuedJobs,
  findStuckRunningJobs,
  markJobFailed,
  markX402JobFailedWithResultAndSettlement,
  purgeExpiredJobResults,
  type ReviewJobRow,
  type X402SettlementStatus,
} from "@/lib/review-job-queries";
import { processReviewJob, terminalizeAcpJobFailure } from "@/lib/review-job-worker";
import { refundJobChannelDebit } from "@/lib/paywall/refund";
import { x402FailureMessage, x402FailureResultPayload } from "@/lib/x402/review-job-result";

export const runtime = "nodejs";
export const maxDuration = 300;

const ORPHAN_THRESHOLD_MS = 60 * 1000;
const STUCK_THRESHOLD_MS = 600 * 1000;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireCronAuth(req, {
    missingEvent: "review_jobs_cron.misconfigured",
    unauthorizedEvent: "review_jobs_cron.unauthorized",
  });
  if (auth !== null) return auth;

  const t0 = Date.now();
  const now = new Date();
  let orphansRetriggered = 0;
  let stuckTimedOut = 0;
  let expiredPurged = 0;

  try {
    // 1. Orphan pickup: queued jobs older than 60s.
    // Fire-and-forget via after() — the cron is responsible for
    // re-triggering, not executing. Each orphan runs concurrently
    // so a slow review doesn't starve the batch.
    const orphanThreshold = new Date(now.getTime() - ORPHAN_THRESHOLD_MS);
    const orphans = await findStaleQueuedJobs(db, orphanThreshold);
    for (const orphan of orphans) {
      if (orphan.paymentRail === "acp" && !shouldProcessAcpJobsInWebCron()) {
        logInfo("review_jobs_cron.acp_orphan_skipped", { jobId: orphan.jobId });
        continue;
      }
      after(async () => {
        try {
          await processReviewJob(orphan.jobId);
        } catch (err) {
          logError("review_jobs_cron.orphan_retrigger_failed", {
            jobId: orphan.jobId,
            message: messageOf(err),
          });
        }
      });
      orphansRetriggered++;
      logInfo("review_jobs_cron.orphan_retriggered", {
        jobId: orphan.jobId,
        ageMs: now.getTime() - orphan.createdAt.getTime(),
      });
    }

    // 2. Stuck timeout: running jobs older than 600s
    const stuckThreshold = new Date(now.getTime() - STUCK_THRESHOLD_MS);
    const stuck = await findStuckRunningJobs(db, stuckThreshold);
    for (const job of stuck) {
      if (job.paymentRail === "acp" && !shouldProcessAcpJobsInWebCron()) {
        logInfo("review_jobs_cron.acp_stuck_skipped", { jobId: job.jobId });
        continue;
      }
      try {
        await timeoutStuckReviewJob(job, now);
        stuckTimedOut++;
        logInfo("review_jobs_cron.stuck_timed_out", {
          jobId: job.jobId,
          startedAt: job.startedAt?.toISOString(),
        });
      } catch (err) {
        logError("review_jobs_cron.stuck_timeout_failed", {
          jobId: job.jobId,
          message: messageOf(err),
        });
      }
    }

    // 3. Expired cleanup: purge result JSON
    expiredPurged = await purgeExpiredJobResults(db, now);
    if (expiredPurged > 0) {
      logInfo("review_jobs_cron.expired_purged", { count: expiredPurged });
    }
  } catch (err) {
    logError("review_jobs_cron.failed", { message: messageOf(err) });
    return new NextResponse("cron tick failed", { status: 500 });
  }

  const elapsedMs = Date.now() - t0;
  const result = { orphansRetriggered, stuckTimedOut, expiredPurged, elapsedMs };
  logInfo("review_jobs_cron.complete", result);
  return NextResponse.json(result);
}

export async function timeoutStuckReviewJob(job: ReviewJobRow, now: Date): Promise<void> {
  if (job.paymentRail === "x402") {
    const settlementStatus = terminalX402SettlementStatus(job.x402SettlementStatus);
    await markX402JobFailedWithResultAndSettlement(
      db,
      job.jobId,
      "timeout",
      x402FailureMessage("timeout", settlementStatus),
      x402FailureResultPayload(job, settlementStatus),
      settlementStatus,
      settlementStatus === "not_settled" ? null : job.x402SettlementResponse,
      now,
    );
    return;
  }
  if (job.paymentRail === "acp") {
    await terminalizeAcpJobFailure({
      job,
      jobId: job.jobId,
      failureMode: "timeout",
      publicMessage: "review exceeded 10-minute timeout",
      rawMessage: "review_jobs cron timed out a stuck ACP job",
    });
    return;
  }

  await markJobFailed(db, job.jobId, "timeout", "review exceeded 10-minute timeout", now);
  try {
    await refundJobChannelDebit(db, job.jobId);
    logInfo("review_jobs_cron.stuck_refunded", { jobId: job.jobId });
  } catch (refundErr) {
    logError("review_jobs_cron.stuck_refund_failed", {
      jobId: job.jobId,
      message: messageOf(refundErr),
    });
  }
}

function terminalX402SettlementStatus(
  current: X402SettlementStatus | null | undefined,
): X402SettlementStatus {
  if (current === "settled" || current === "settlement_failed") return current;
  return "not_settled";
}

function shouldProcessAcpJobsInWebCron(): boolean {
  return (
    process.env["ACP_WEB_CRON_ENABLED"] === "1" || process.env["ACP_WEB_CRON_ENABLED"] === "true"
  );
}
