// GET /api/cron/review-jobs — safety-net cron for orphan/stuck review jobs.
//
// Runs every minute. Three sweeps:
//   1. Orphan pickup: status='queued' older than 60s — waitUntil() didn't fire.
//      Re-triggers the worker.
//   2. Stuck timeout: status='running' with started_at older than 600s (10 min).
//      Marks failed (failure_mode='timeout') and triggers refund.
//   3. Expired cleanup: expires_at < now(). Purges result JSON to save storage;
//      metadata kept for audit.

import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { after, NextResponse } from "next/server";
import { db } from "@/db";
import { logError, logInfo, logWarn, messageOf } from "@/lib/log";
import {
  findStaleQueuedJobs,
  findStuckRunningJobs,
  markJobFailed,
  purgeExpiredJobResults,
} from "@/lib/review-job-queries";
import { processReviewJob } from "@/lib/review-job-worker";
import { refundJobChannelDebit } from "@/lib/paywall/refund";

export const runtime = "nodejs";
export const maxDuration = 300;

const ORPHAN_THRESHOLD_MS = 60 * 1000;
const STUCK_THRESHOLD_MS = 600 * 1000;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env["CRON_SECRET"];
  if (secret === undefined || secret.length === 0) {
    logError("review_jobs_cron.misconfigured", { reason: "CRON_SECRET missing" });
    return new NextResponse("server misconfigured", { status: 500 });
  }
  const authHeader = req.headers.get("authorization");
  const expected = `Bearer ${secret}`;
  const provided = authHeader ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    logWarn("review_jobs_cron.unauthorized", { hasAuth: authHeader !== null });
    return new NextResponse("unauthorized", { status: 401 });
  }

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
      try {
        await markJobFailed(db, job.jobId, "timeout", "review exceeded 10-minute timeout", now);
        stuckTimedOut++;
        logInfo("review_jobs_cron.stuck_timed_out", {
          jobId: job.jobId,
          startedAt: job.startedAt?.toISOString(),
        });
        // Trigger refund for timeout
        try {
          await refundJobChannelDebit(db, job.jobId);
          logInfo("review_jobs_cron.stuck_refunded", { jobId: job.jobId });
        } catch (refundErr) {
          logError("review_jobs_cron.stuck_refund_failed", {
            jobId: job.jobId,
            message: messageOf(refundErr),
          });
        }
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
