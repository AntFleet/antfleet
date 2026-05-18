import { describe, expect, it, vi } from "vitest";
import { runReviewRetryTick, type RetryDeps } from "./review-retry";
import type { WorkerDeps, WorkerOutcome } from "./review-worker";

const NOW = new Date("2026-05-18T12:00:00Z");

function mkOutcome(overrides: Partial<WorkerOutcome> = {}): WorkerOutcome {
  return {
    kind: "done",
    reviewId: "rev-1",
    agreedCount: 1,
    degraded: false,
    ...overrides,
  } as WorkerOutcome;
}

// The retry tick doesn't actually use the worker's deps inside this lane —
// it just hands them off. A bare object satisfies the type.
const fakeWorkerDeps = {} as WorkerDeps;

function mkDeps(overrides: Partial<RetryDeps> = {}): RetryDeps {
  return {
    loadReviewsReadyForRetry: vi.fn().mockResolvedValue([]),
    runReviewWorker: vi.fn().mockResolvedValue(mkOutcome()),
    workerDeps: fakeWorkerDeps,
    now: () => NOW,
    ...overrides,
  };
}

describe("runReviewRetryTick", () => {
  it("returns zero counters when there is no work", async () => {
    const deps = mkDeps();
    const result = await runReviewRetryTick(deps);
    expect(result).toEqual({
      candidatesFound: 0,
      processed: 0,
      succeeded: 0,
      retried: 0,
      failed: 0,
      skipped: 0,
      errors: [],
    });
    expect(deps.runReviewWorker).not.toHaveBeenCalled();
  });

  it("uses 5-minute stuck-after window when loading candidates", async () => {
    const loadFn = vi.fn().mockResolvedValue([]);
    const deps = mkDeps({ loadReviewsReadyForRetry: loadFn });
    await runReviewRetryTick(deps);
    const args = loadFn.mock.calls[0][0];
    expect(args.now).toEqual(NOW);
    expect(args.stuckBefore.getTime()).toBe(NOW.getTime() - 5 * 60 * 1000);
    expect(args.limit).toBe(10);
  });

  it("counts outcomes by kind", async () => {
    const candidates = [
      { reviewId: "a", processingStatus: "pending", processingAttempts: 0 },
      { reviewId: "b", processingStatus: "pending_retry", processingAttempts: 2 },
      { reviewId: "c", processingStatus: "pending_retry", processingAttempts: 5 },
      { reviewId: "d", processingStatus: "in_progress", processingAttempts: 1 },
    ];
    const worker = vi
      .fn()
      .mockResolvedValueOnce(mkOutcome({ kind: "done", reviewId: "a" }))
      .mockResolvedValueOnce(
        mkOutcome({
          kind: "retried",
          reviewId: "b",
          attempts: 3,
          nextRetryAt: NOW,
          error: "429",
        }) as WorkerOutcome,
      )
      .mockResolvedValueOnce(
        mkOutcome({ kind: "failed", reviewId: "c", attempts: 6, error: "boom" }) as WorkerOutcome,
      )
      .mockResolvedValueOnce(
        mkOutcome({ kind: "skipped", reviewId: "d", reason: "already_done" }) as WorkerOutcome,
      );
    const deps = mkDeps({
      loadReviewsReadyForRetry: vi.fn().mockResolvedValue(candidates),
      runReviewWorker: worker,
    });
    const result = await runReviewRetryTick(deps);
    expect(result.candidatesFound).toBe(4);
    expect(result.processed).toBe(4);
    expect(result.succeeded).toBe(1);
    expect(result.retried).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("records an error when the worker throws but keeps processing the batch", async () => {
    const candidates = [
      { reviewId: "a", processingStatus: "pending", processingAttempts: 0 },
      { reviewId: "b", processingStatus: "pending", processingAttempts: 0 },
    ];
    const worker = vi
      .fn()
      .mockRejectedValueOnce(new Error("db conn lost"))
      .mockResolvedValueOnce(mkOutcome({ kind: "done", reviewId: "b" }));
    const deps = mkDeps({
      loadReviewsReadyForRetry: vi.fn().mockResolvedValue(candidates),
      runReviewWorker: worker,
    });
    const result = await runReviewRetryTick(deps);
    expect(result.candidatesFound).toBe(2);
    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual({ reviewId: "a", message: "db conn lost" });
  });

  it("calls the worker with source='cron'", async () => {
    const candidates = [{ reviewId: "a", processingStatus: "pending", processingAttempts: 0 }];
    const worker = vi.fn().mockResolvedValue(mkOutcome({ kind: "done", reviewId: "a" }));
    const deps = mkDeps({
      loadReviewsReadyForRetry: vi.fn().mockResolvedValue(candidates),
      runReviewWorker: worker,
    });
    await runReviewRetryTick(deps);
    expect(worker).toHaveBeenCalledWith("a", "cron", fakeWorkerDeps);
  });
});
