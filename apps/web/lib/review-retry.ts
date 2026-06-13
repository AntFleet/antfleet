// Mission 7 — retry-cron orchestrator. Sibling of sweep.ts: dependency-
// injected for testability, with the route handler at
// app/api/cron/review-retry/route.ts wiring the real implementations.
// Picks rows ready for (re)processing and drives them through
// runReviewWorker. Concurrency is intentionally capped — the goal is
// to avoid recreating the original concurrency-induced rate-limit
// problem this whole queue exists to fix.

import {
  loadReviewsReadyForRetry as realLoadReviewsReadyForRetry,
  type RetryCandidate,
} from "@/db/queries";
import { logError, logInfo, messageOf } from "./log";
import {
  realWorkerDeps,
  runReviewWorker as realRunReviewWorker,
  STUCK_AFTER_MS,
  type WorkerDeps,
  type WorkerOutcome,
} from "./review-worker";

// Per-tick batch size. The retry cron runs every 2 minutes; processing
// more than this in one tick risks hitting the same LLM rate-limit
// ceiling the queue was built to avoid. With 10 max and 2-min cadence
// the system absorbs a 300-PR burst in ~60 minutes worst-case (well
// inside the operator's tolerance for "we got everything").
export const RETRY_BATCH_LIMIT = 10;

// Within a single tick, we still process the batch SERIALLY rather
// than in parallel. The dominant cost per row is the LLM round-trip
// (~30-90s); 10 parallel calls would compound against the upstream
// rate limits that triggered the original incident. Serial keeps the
// recovery rate-aware. Promote to a small parallelism (e.g. 2-3) only
// after the AI Gateway rate-limit observability lands.
export const RETRY_CONCURRENCY = 1;

export type RetryCronResult = {
  candidatesFound: number;
  processed: number;
  succeeded: number;
  retried: number;
  failed: number;
  skipped: number;
  errors: Array<{ reviewId: string; message: string }>;
};

export type RetryDeps = {
  loadReviewsReadyForRetry: typeof realLoadReviewsReadyForRetry;
  runReviewWorker: typeof realRunReviewWorker;
  workerDeps: WorkerDeps;
  now: () => Date;
};

export function realRetryDeps(): RetryDeps {
  const workerDeps = realWorkerDeps();
  return {
    loadReviewsReadyForRetry: realLoadReviewsReadyForRetry,
    runReviewWorker: realRunReviewWorker,
    workerDeps,
    now: () => new Date(),
  };
}

export async function runReviewRetryTick(
  deps: RetryDeps = realRetryDeps(),
): Promise<RetryCronResult> {
  const now = deps.now();
  const stuckBefore = new Date(now.getTime() - STUCK_AFTER_MS);
  const candidates: RetryCandidate[] = await deps.loadReviewsReadyForRetry({
    now,
    stuckBefore,
    limit: RETRY_BATCH_LIMIT,
  });

  const result: RetryCronResult = {
    candidatesFound: candidates.length,
    processed: 0,
    succeeded: 0,
    retried: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  for (const candidate of candidates) {
    let outcome: WorkerOutcome;
    try {
      outcome = await deps.runReviewWorker(candidate.reviewId, "cron", deps.workerDeps);
    } catch (err) {
      const message = messageOf(err);
      logError("retry_cron.worker_threw", { reviewId: candidate.reviewId, message });
      result.errors.push({ reviewId: candidate.reviewId, message });
      continue;
    }
    result.processed += 1;
    if (outcome.kind === "done") result.succeeded += 1;
    else if (outcome.kind === "retried") result.retried += 1;
    else if (outcome.kind === "failed") result.failed += 1;
    else result.skipped += 1;
    logInfo("retry_cron.row_processed", {
      reviewId: candidate.reviewId,
      kind: outcome.kind,
      lifecycle: candidate.kind,
      priorAttempts: candidate.processingAttempts,
    });
  }

  return result;
}
