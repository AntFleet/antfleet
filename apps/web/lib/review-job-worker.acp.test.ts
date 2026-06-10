import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMocks = vi.hoisted(() => ({
  getReviewJob: vi.fn(),
  markAcpJobReviewLinked: vi.fn(),
  markAcpJobSubmitFailed: vi.fn(),
  markAcpJobSubmitting: vi.fn(),
  markAcpJobSubmitted: vi.fn(),
  markJobComplete: vi.fn(),
  markJobFailed: vi.fn(),
  markJobFailedWithResult: vi.fn(),
  markJobRunning: vi.fn(),
  markX402JobCompleteSettled: vi.fn(),
  markX402JobFailedWithResultAndSettlement: vi.fn(),
  markX402JobReviewLinked: vi.fn(),
  markX402SettlementFailed: vi.fn(),
  markX402SettlementNotSettled: vi.fn(),
  markX402SettlementSettled: vi.fn(),
}));

const dbQueryMocks = vi.hoisted(() => ({
  enqueueReview: vi.fn(),
  hashRepo: vi.fn(),
  markReviewSucceeded: vi.fn(),
  recordFindingStatuses: vi.fn(),
  updateReview: vi.fn(),
}));

const paywallQueryMocks = vi.hoisted(() => ({
  loadReviewForResponse: vi.fn(),
}));

const acpCliMocks = vi.hoisted(() => ({
  submitAcpDeliverable: vi.fn(),
}));

const repoVisibilityMocks = vi.hoisted(() => ({
  isPublicRepo: vi.fn(),
}));

const octokitMocks = vi.hoisted(() => ({
  pullsGet: vi.fn(),
  pullsList: vi.fn(),
  paginate: vi.fn(),
}));

const githubFileMocks = vi.hoisted(() => ({
  getPublicChangedFiles: vi.fn(),
}));

const logMocks = vi.hoisted(() => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/review-job-queries", () => queryMocks);
vi.mock("@/db/queries", () => dbQueryMocks);
vi.mock("@/lib/paywall/queries", () => paywallQueryMocks);
vi.mock("@/lib/acp/provider-cli", () => acpCliMocks);
vi.mock("@/lib/github-files-public", () => ({
  getPublicChangedFiles: githubFileMocks.getPublicChangedFiles,
  makePublicOctokit: () => ({
    rest: { pulls: { get: octokitMocks.pullsGet, list: octokitMocks.pullsList } },
    paginate: octokitMocks.paginate,
  }),
}));
vi.mock("@/lib/review-pipeline", () => ({ reviewPR: vi.fn() }));
vi.mock("@/lib/paywall/env", () => ({ getReviewPriceUsdc: () => "1.00" }));
vi.mock("@/lib/github-app", () => ({ getInstallationToken: vi.fn() }));
vi.mock("@/lib/repo-visibility", () => repoVisibilityMocks);
vi.mock("@/lib/repo-benchmark", () => ({ isBenchmarkRepo: vi.fn() }));
vi.mock("@/lib/review-worker", () => ({ runReviewWorker: vi.fn() }));
vi.mock("@/lib/log", () => ({
  logError: logMocks.logError,
  logInfo: logMocks.logInfo,
  messageOf: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));
vi.mock("@/lib/paywall/refund", () => ({
  refundJobChannelDebit: vi.fn(),
  isRefundableFailureMode: () => false,
  safeFailureMessage: (mode: string) => `safe:${mode}`,
}));
vi.mock("@/lib/x402/env", () => ({
  X402_MAX_TIMEOUT_SECONDS: 600,
  loadX402Config: () => ({ treasury: "0x000000000000000000000000000000000000dEaD" }),
}));
vi.mock("@/lib/x402/facilitator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/x402/facilitator")>();
  return {
    ...actual,
    settlePayment: vi.fn(),
  };
});
vi.mock("@octokit/rest", () => ({
  Octokit: class MockOctokit {
    rest = { pulls: { get: octokitMocks.pullsGet, list: octokitMocks.pullsList } };
    paginate = octokitMocks.paginate;
  },
}));

const acpJob = {
  jobId: "af-acp-job",
  installationId: "acp",
  walletAddress: "0x1111111111111111111111111111111111111111",
  repoOwner: "antfleet",
  repoName: "acp-fixture",
  prNumber: 7,
  sha: null,
  idempotencyKey: "acp:43868",
  status: "queued",
  failureMode: null,
  failureMessage: null,
  result: null,
  debitPaymentId: null,
  refundPaymentId: null,
  callerWallet: "0x1111111111111111111111111111111111111111",
  paymentRail: "acp" as const,
  x402PayTo: null,
  x402PaymentPayload: null,
  x402ValidAfter: null,
  x402ValidBefore: null,
  x402ReviewId: null,
  x402SettlementStatus: null,
  x402SettlementResponse: null,
  acpJobId: "43868",
  acpClientWallet: "0x1111111111111111111111111111111111111111",
  acpRequestPayload: { options: { focus: ["security"] } },
  acpReviewId: null,
  acpSubmitStatus: "pending" as const,
  acpSubmitResponse: null,
  acpSubmittedAt: null,
  createdAt: new Date("2026-06-10T00:00:00Z"),
  startedAt: null,
  completedAt: null,
  expiresAt: new Date("2026-06-11T00:00:00Z"),
};

describe("processReviewJob ACP rail", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    queryMocks.getReviewJob.mockResolvedValue(acpJob);
    queryMocks.markJobRunning.mockResolvedValue(true);
    queryMocks.markJobComplete.mockResolvedValue(true);
    queryMocks.markAcpJobSubmitting.mockResolvedValue(true);
    repoVisibilityMocks.isPublicRepo.mockResolvedValue(true);
    dbQueryMocks.hashRepo.mockReturnValue("repo-hash");
    dbQueryMocks.enqueueReview.mockResolvedValue({ reviewId: "review-1", isNew: false });
    octokitMocks.pullsGet.mockResolvedValue({
      data: { state: "open", head: { sha: "4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001" } },
    });
    paywallQueryMocks.loadReviewForResponse.mockResolvedValue({
      reviewId: "review-1",
      owner: "antfleet",
      repo: "acp-fixture",
      prNumber: 7,
      commitSha: "4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001",
      providerModelIds: { anthropic: "claude-opus-4-7", openai: "gpt-5" },
      agreementDecision: { mode: "unanimous", agreed: [], degraded: false },
      publicReceipt: true,
      isBenchmark: false,
      prCommentUrl: null,
      processingStatus: "done",
      processingError: null,
      timingMs: 1234,
      costEstimatedUsd: "0.12",
      findingIds: [],
    });
    acpCliMocks.submitAcpDeliverable.mockResolvedValue({
      stdout: "{}",
      stderr: "",
      json: { txHash: "0xacp" },
    });
  });

  it("builds and submits an ACP deliverable through the existing review job worker", async () => {
    const { processReviewJob } = await import("./review-job-worker");
    const outcome = await processReviewJob("af-acp-job");

    expect(outcome).toEqual({ kind: "complete", jobId: "af-acp-job" });
    expect(queryMocks.markAcpJobReviewLinked).toHaveBeenCalledWith({}, "af-acp-job", "review-1");
    expect(acpCliMocks.submitAcpDeliverable).toHaveBeenCalledWith({
      acpJobId: "43868",
      deliverable: expect.objectContaining({
        schema_version: "antfleet.acp.review.deliverable.v0",
        status: "complete_no_findings",
        job: expect.objectContaining({
          acp_job_id: "43868",
          antfleet_job_id: "af-acp-job",
        }),
      }),
    });
    expect(queryMocks.markAcpJobSubmitting).toHaveBeenCalledWith(
      {},
      "af-acp-job",
      expect.objectContaining({ status: "complete_no_findings" }),
      expect.any(Date),
    );
    expect(queryMocks.markAcpJobSubmitted).toHaveBeenCalledWith(
      {},
      "af-acp-job",
      { txHash: "0xacp" },
      expect.any(Date),
    );
    expect(queryMocks.markJobComplete).toHaveBeenCalledWith(
      {},
      "af-acp-job",
      expect.objectContaining({ status: "complete_no_findings" }),
      expect.any(Date),
    );
  });

  it("includes the trading disclaimer when the buyer acknowledged trading-code boundaries", async () => {
    queryMocks.getReviewJob.mockResolvedValueOnce({
      ...acpJob,
      acpRequestPayload: {
        options: {
          public_receipt: true,
          max_findings: 10,
          acknowledge_not_financial_advice: true,
        },
      },
    });

    const { processReviewJob } = await import("./review-job-worker");
    const outcome = await processReviewJob("af-acp-job");

    expect(outcome).toEqual({ kind: "complete", jobId: "af-acp-job" });
    expect(acpCliMocks.submitAcpDeliverable).toHaveBeenCalledWith({
      acpJobId: "43868",
      deliverable: expect.objectContaining({
        disclaimer:
          "AntFleet reviews code structure and implementation risks. It does not evaluate trading profitability, market strategy, regulatory suitability, portfolio risk, or whether an autonomous agent should trade. Findings are not financial advice.",
      }),
    });
  });

  it("fails instead of reviewing a moved PR head after ACP intake resolved a SHA", async () => {
    queryMocks.getReviewJob.mockResolvedValueOnce({
      ...acpJob,
      sha: "4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001",
    });
    octokitMocks.pullsGet.mockResolvedValueOnce({
      data: { state: "open", head: { sha: "99999f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f999" } },
    });

    const { processReviewJob } = await import("./review-job-worker");
    const outcome = await processReviewJob("af-acp-job");

    expect(outcome).toMatchObject({
      kind: "failed",
      jobId: "af-acp-job",
      failureMode: "sha_not_in_open_pr",
    });
    expect(dbQueryMocks.enqueueReview).not.toHaveBeenCalled();
    expect(githubFileMocks.getPublicChangedFiles).not.toHaveBeenCalled();
    expect(acpCliMocks.submitAcpDeliverable).toHaveBeenCalledWith({
      acpJobId: "43868",
      deliverable: expect.objectContaining({
        schema_version: "antfleet.acp.review.error.v0",
        status: "failed",
        error: expect.objectContaining({ code: "sha_not_in_open_pr" }),
      }),
    });
  });

  it("submits ACP error payloads and preserves them on failed jobs", async () => {
    octokitMocks.pullsGet.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));

    const { processReviewJob } = await import("./review-job-worker");
    const outcome = await processReviewJob("af-acp-job");

    expect(outcome).toMatchObject({ kind: "failed", jobId: "af-acp-job" });
    expect(acpCliMocks.submitAcpDeliverable).toHaveBeenCalledWith({
      acpJobId: "43868",
      deliverable: expect.objectContaining({
        schema_version: "antfleet.acp.review.error.v0",
        status: "failed",
        error: expect.objectContaining({ code: "repo_not_accessible" }),
      }),
    });
    expect(queryMocks.markJobFailedWithResult).toHaveBeenCalledWith(
      {},
      "af-acp-job",
      "repo_not_accessible",
      "The target repository is not publicly accessible.",
      expect.objectContaining({ status: "failed" }),
      expect.any(Date),
    );
  });

  it("uses ACP-specific public failure messages instead of channel refund wording", async () => {
    octokitMocks.pullsGet.mockRejectedValue(
      Object.assign(new Error("github 500"), { status: 500 }),
    );

    const { processReviewJob } = await import("./review-job-worker");
    const outcome = await processReviewJob("af-acp-job");

    expect(outcome).toMatchObject({
      kind: "failed",
      jobId: "af-acp-job",
      failureMode: "provider_error",
      failureMessage:
        "The ACP review provider returned an error before a successful deliverable could be submitted.",
    });
    expect(acpCliMocks.submitAcpDeliverable).toHaveBeenCalledWith({
      acpJobId: "43868",
      deliverable: expect.objectContaining({
        schema_version: "antfleet.acp.review.error.v0",
        status: "failed",
        error: expect.objectContaining({
          code: "provider_error",
          message:
            "The ACP review provider returned an error before a successful deliverable could be submitted.",
          settlement: "escrow_refundable",
        }),
      }),
    });
    const submitted = acpCliMocks.submitAcpDeliverable.mock.calls[0]?.[0] as
      | { deliverable?: unknown }
      | undefined;
    expect(JSON.stringify(submitted?.deliverable)).not.toMatch(/channel|refunded/i);
  });

  it("does not submit ACP error payloads unless the submit claim is won", async () => {
    queryMocks.markAcpJobSubmitting.mockResolvedValueOnce(false);

    const { terminalizeAcpJobFailure } = await import("./review-job-worker");
    await expect(
      terminalizeAcpJobFailure({
        job: acpJob,
        jobId: "af-acp-job",
        failureMode: "timeout",
        publicMessage: "review exceeded 10-minute timeout",
        rawMessage: "cron timeout",
      }),
    ).rejects.toThrow("ACP error deliverable submission was not claimed");

    expect(acpCliMocks.submitAcpDeliverable).not.toHaveBeenCalled();
    expect(queryMocks.markJobFailedWithResult).not.toHaveBeenCalled();
  });

  it("submits ACP no_reviewable_files errors instead of success semantics", async () => {
    dbQueryMocks.enqueueReview.mockResolvedValueOnce({ reviewId: "review-empty", isNew: true });
    githubFileMocks.getPublicChangedFiles.mockResolvedValueOnce([]);

    const { processReviewJob } = await import("./review-job-worker");
    const outcome = await processReviewJob("af-acp-job");

    expect(outcome).toMatchObject({
      kind: "failed",
      failureMode: "no_reviewable_files",
    });
    expect(dbQueryMocks.markReviewSucceeded).not.toHaveBeenCalled();
    expect(acpCliMocks.submitAcpDeliverable).toHaveBeenCalledWith({
      acpJobId: "43868",
      deliverable: expect.objectContaining({
        schema_version: "antfleet.acp.review.error.v0",
        status: "failed",
        error: expect.objectContaining({ code: "no_reviewable_files" }),
      }),
    });
  });

  it("marks ambiguous ACP success submit failures without sending a second error", async () => {
    acpCliMocks.submitAcpDeliverable.mockRejectedValue(new Error("CLI submitted but lost receipt"));

    const { processReviewJob } = await import("./review-job-worker");
    const outcome = await processReviewJob("af-acp-job");

    expect(outcome).toMatchObject({
      kind: "failed",
      jobId: "af-acp-job",
      failureMode: "internal",
    });
    expect(acpCliMocks.submitAcpDeliverable).toHaveBeenCalledTimes(1);
    expect(queryMocks.markAcpJobSubmitFailed).toHaveBeenCalledWith(
      {},
      "af-acp-job",
      expect.objectContaining({
        message:
          "ACP success deliverable submission is ambiguous; operator reconciliation required",
        originalFailure: "CLI submitted but lost receipt",
      }),
      expect.any(Date),
    );
    expect(queryMocks.markJobFailedWithResult).toHaveBeenCalledWith(
      {},
      "af-acp-job",
      "internal",
      "An internal error occurred after ACP deliverable submission. The ACP submission is preserved.",
      expect.objectContaining({ status: "complete_no_findings" }),
      expect.any(Date),
    );
  });

  it("redacts raw ACP CLI failure text from worker logs", async () => {
    acpCliMocks.submitAcpDeliverable.mockRejectedValue(
      new Error("Command failed: acp provider submit --deliverable secret stdout=token stderr=key"),
    );

    const { processReviewJob } = await import("./review-job-worker");
    await processReviewJob("af-acp-job");

    const failedLog = logMocks.logError.mock.calls.find(
      ([event, fields]) =>
        event === "review_job" &&
        typeof fields === "object" &&
        fields !== null &&
        (fields as Record<string, unknown>)["event"] === "failed",
    );
    expect(failedLog).toBeDefined();
    expect(JSON.stringify(failedLog)).not.toContain("secret");
    expect(JSON.stringify(failedLog)).not.toContain("stdout");
    expect(JSON.stringify(failedLog)).not.toContain("stderr");
    expect(JSON.stringify(failedLog)).not.toContain("--deliverable");
  });

  it("does not report ACP success when the guarded complete write is a no-op", async () => {
    queryMocks.markJobComplete.mockResolvedValueOnce(false);

    const { processReviewJob } = await import("./review-job-worker");
    const outcome = await processReviewJob("af-acp-job");

    expect(outcome).toMatchObject({
      kind: "failed",
      jobId: "af-acp-job",
      failureMode: "internal",
    });
    expect(queryMocks.markJobFailedWithResult).toHaveBeenCalledWith(
      {},
      "af-acp-job",
      "internal",
      "An internal error occurred after ACP deliverable submission. The ACP submission is preserved.",
      expect.objectContaining({ status: "complete_no_findings" }),
      expect.any(Date),
    );
  });

  it("does not submit timeout errors when a prior ACP submit is in progress", async () => {
    const submittingJob = {
      ...acpJob,
      acpSubmitStatus: "submitting" as const,
      acpSubmitResponse: {
        state: "submitting",
        deliverable: { schema_version: "antfleet.acp.review.deliverable.v0", status: "complete" },
      },
    };

    const { terminalizeAcpJobFailure } = await import("./review-job-worker");
    const outcome = await terminalizeAcpJobFailure({
      job: submittingJob,
      jobId: "af-acp-job",
      failureMode: "timeout",
      publicMessage: "review exceeded 10-minute timeout",
      rawMessage: "cron timeout",
    });

    expect(outcome).toMatchObject({
      failureMode: "internal",
    });
    expect(acpCliMocks.submitAcpDeliverable).not.toHaveBeenCalled();
    expect(queryMocks.markJobFailedWithResult).toHaveBeenCalledWith(
      {},
      "af-acp-job",
      "internal",
      "ACP deliverable submission is already in progress. Operator reconciliation is required.",
      { schema_version: "antfleet.acp.review.deliverable.v0", status: "complete" },
      expect.any(Date),
    );
  });

  it("does not submit timeout errors when a prior ACP submit was persisted", async () => {
    const submittedJob = {
      ...acpJob,
      acpSubmitStatus: "submitted" as const,
      acpSubmitResponse: {
        state: "submitted",
        deliverable: { schema_version: "antfleet.acp.review.deliverable.v0", status: "complete" },
        response: { txHash: "0xacp" },
      },
    };

    const { terminalizeAcpJobFailure } = await import("./review-job-worker");
    const outcome = await terminalizeAcpJobFailure({
      job: submittedJob,
      jobId: "af-acp-job",
      failureMode: "timeout",
      publicMessage: "review exceeded 10-minute timeout",
      rawMessage: "cron timeout",
    });

    expect(outcome).toMatchObject({
      failureMode: "internal",
    });
    expect(acpCliMocks.submitAcpDeliverable).not.toHaveBeenCalled();
    expect(queryMocks.markJobFailedWithResult).toHaveBeenCalledWith(
      {},
      "af-acp-job",
      "internal",
      "ACP deliverable was already submitted. Operator reconciliation is required.",
      { schema_version: "antfleet.acp.review.deliverable.v0", status: "complete" },
      expect.any(Date),
    );
  });

  it("does not submit a contradictory ACP error after successful deliverable submission", async () => {
    queryMocks.markJobComplete.mockRejectedValue(new Error("db write failed"));

    const { processReviewJob } = await import("./review-job-worker");
    const outcome = await processReviewJob("af-acp-job");

    expect(outcome).toMatchObject({
      kind: "failed",
      jobId: "af-acp-job",
      failureMode: "internal",
    });
    expect(acpCliMocks.submitAcpDeliverable).toHaveBeenCalledTimes(1);
    expect(acpCliMocks.submitAcpDeliverable).toHaveBeenCalledWith({
      acpJobId: "43868",
      deliverable: expect.objectContaining({
        schema_version: "antfleet.acp.review.deliverable.v0",
        status: "complete_no_findings",
      }),
    });
    expect(queryMocks.markJobFailedWithResult).toHaveBeenCalledWith(
      {},
      "af-acp-job",
      "internal",
      "An internal error occurred after ACP deliverable submission. The ACP submission is preserved.",
      expect.objectContaining({ status: "complete_no_findings" }),
      expect.any(Date),
    );
  });
});
