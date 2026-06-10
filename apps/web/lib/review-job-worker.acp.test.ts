import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMocks = vi.hoisted(() => ({
  getReviewJob: vi.fn(),
  markAcpJobReviewLinked: vi.fn(),
  markAcpJobSubmitFailed: vi.fn(),
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

const octokitMocks = vi.hoisted(() => ({
  pullsGet: vi.fn(),
  pullsList: vi.fn(),
  paginate: vi.fn(),
}));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/review-job-queries", () => queryMocks);
vi.mock("@/db/queries", () => dbQueryMocks);
vi.mock("@/lib/paywall/queries", () => paywallQueryMocks);
vi.mock("@/lib/acp/provider-cli", () => acpCliMocks);
vi.mock("@/lib/github-files-public", () => ({ getPublicChangedFiles: vi.fn() }));
vi.mock("@/lib/review-pipeline", () => ({ reviewPR: vi.fn() }));
vi.mock("@/lib/paywall/env", () => ({ getReviewPriceUsdc: () => "1.00" }));
vi.mock("@/lib/github-app", () => ({ getInstallationToken: vi.fn() }));
vi.mock("@/lib/repo-visibility", () => ({ isPublicRepo: vi.fn() }));
vi.mock("@/lib/repo-benchmark", () => ({ isBenchmarkRepo: vi.fn() }));
vi.mock("@/lib/review-worker", () => ({ runReviewWorker: vi.fn() }));
vi.mock("@/lib/log", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
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

  it("submits ACP error payloads and preserves them on failed jobs", async () => {
    octokitMocks.pullsGet.mockRejectedValue(new Error("not found"));

    const { processReviewJob } = await import("./review-job-worker");
    const outcome = await processReviewJob("af-acp-job");

    expect(outcome).toMatchObject({ kind: "failed", jobId: "af-acp-job" });
    expect(acpCliMocks.submitAcpDeliverable).toHaveBeenCalledWith({
      acpJobId: "43868",
      deliverable: expect.objectContaining({
        schema_version: "antfleet.acp.review.error.v0",
        status: "failed",
        error: expect.objectContaining({ code: "pr_not_found" }),
      }),
    });
    expect(queryMocks.markJobFailedWithResult).toHaveBeenCalledWith(
      {},
      "af-acp-job",
      "pr_not_found",
      "safe:pr_not_found",
      expect.objectContaining({ status: "failed" }),
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
