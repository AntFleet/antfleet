import { describe, expect, it, vi } from "vitest";
import { recoverAcpReviewJobs, safeAcpProviderWorkerErrorSummary } from "./acp-provider-worker";

const queuedAcpJob = {
  jobId: "af-acp-queued",
  paymentRail: "acp" as const,
};

const stuckAcpJob = {
  jobId: "af-acp-stuck",
  paymentRail: "acp" as const,
};

describe("ACP provider worker recovery", () => {
  it("retries stale ACP queued jobs and terminalizes stuck ACP running jobs", async () => {
    const findStaleQueuedJobs = vi
      .fn()
      .mockResolvedValue([queuedAcpJob, { jobId: "job-x402-queued", paymentRail: "x402" }]);
    const findStuckRunningJobs = vi
      .fn()
      .mockResolvedValue([stuckAcpJob, { jobId: "job-x402-stuck", paymentRail: "x402" }]);
    const processReviewJob = vi.fn().mockResolvedValue({
      kind: "complete",
      jobId: "af-acp-queued",
    });
    const terminalizeAcpJobFailure = vi.fn().mockResolvedValue({
      failureMode: "timeout",
      failureMessage: "review exceeded 10-minute timeout",
    });

    const outcome = await recoverAcpReviewJobs({
      db: {} as never,
      reviewJobQueries: { findStaleQueuedJobs, findStuckRunningJobs },
      reviewJobWorker: { processReviewJob, terminalizeAcpJobFailure },
      now: new Date("2026-06-10T00:12:00Z"),
    });

    expect(outcome).toEqual({ orphansRetriggered: 1, stuckTimedOut: 1 });
    expect(processReviewJob).toHaveBeenCalledWith("af-acp-queued");
    expect(terminalizeAcpJobFailure).toHaveBeenCalledWith({
      job: stuckAcpJob,
      jobId: "af-acp-stuck",
      failureMode: "timeout",
      publicMessage: "review exceeded 10-minute timeout",
      rawMessage: "ACP provider worker timed out a stuck ACP job",
    });
  });

  it("redacts provider worker errors that mention CLI stdout or stderr", () => {
    const err = Object.assign(
      new Error("Command failed: acp provider submit stdout=secret-token stderr=private-key"),
      {
        name: "ExecException",
        stdout: "secret-token",
        stderr: "private-key",
      },
    );

    expect(safeAcpProviderWorkerErrorSummary(err)).toEqual({
      name: "ExecException",
      message: "provider worker failed",
    });
  });
});
