import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMocks = vi.hoisted(() => ({
  getReviewJob: vi.fn(),
  markJobRunning: vi.fn(),
  markJobComplete: vi.fn(),
  markJobFailed: vi.fn(),
  markJobFailedWithResult: vi.fn(),
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
  loadPrivateDisclosureFindingIndexes: vi.fn(),
  loadRepoThreatModel: vi.fn(),
  markReviewSucceeded: vi.fn(),
  recordFindingStatuses: vi.fn(),
  recordSingleModelFindingStatuses: vi.fn(),
  recordFindingEvidenceBundleSlot: vi.fn(),
  recordGateOutcome: vi.fn(),
  updateReview: vi.fn(),
  upsertRepoThreatModel: vi.fn(),
}));

const facilitatorMocks = vi.hoisted(() => ({
  settlePayment: vi.fn(),
}));

const publicFilesMocks = vi.hoisted(() => ({
  getPublicChangedFiles: vi.fn(),
  makePublicOctokit: vi.fn(),
}));

const reviewPipelineMocks = vi.hoisted(() => ({
  reviewPR: vi.fn(),
}));

const paywallQueryMocks = vi.hoisted(() => ({
  loadReviewForResponse: vi.fn(),
}));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/review-job-queries", () => queryMocks);
vi.mock("@/db/queries", () => dbQueryMocks);
vi.mock("@/lib/paywall/queries", () => paywallQueryMocks);
vi.mock("@/lib/github-files-public", () => publicFilesMocks);
vi.mock("@/lib/review-pipeline", () => reviewPipelineMocks);
vi.mock("@/lib/disclosure", () => ({
  initializeDisclosureForFindings: vi
    .fn()
    .mockResolvedValue({ embargoedFindingIds: [], embargoedFindingIndexes: [] }),
}));
vi.mock("@/lib/paywall/env", () => ({ getReviewPriceUsdc: () => "0.5" }));
vi.mock("@/lib/github-app", () => ({ getInstallationToken: vi.fn() }));
vi.mock("@/lib/repo-visibility", () => ({ isPublicRepo: vi.fn() }));
vi.mock("@/lib/repo-benchmark", () => ({ isBenchmarkRepo: vi.fn() }));
// review-worker is the home of runReviewKernel (audit T2.3) — both the
// installation lane (runReviewWorker) and the paid lanes call it. We
// only mock runReviewWorker (the installation entry that the paid path
// never invokes); runReviewKernel is the real implementation so the
// kernel's persist + cost-cap + agreementDecision shape stay under test.
vi.mock("@/lib/review-worker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/review-worker")>();
  return { ...actual, runReviewWorker: vi.fn() };
});
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
    settlePayment: facilitatorMocks.settlePayment,
  };
});

const authorizationState = {
  kind: "x402_authorization",
  paymentPayload: { authorization: { from: "0x0000000000000000000000000000000000000001" } },
  paymentPayloadBase64: "eyJhdXRob3JpemF0aW9uIjp7fX0=",
  validAfter: "2026-05-29T00:00:00.000Z",
  validBefore: "2026-05-29T00:10:00.000Z",
  resource: "https://example.test/api/v1/review/x402",
  verifyResponse: { isValid: true },
};

const x402Job = {
  jobId: "job-x402",
  installationId: "x402",
  walletAddress: "0x0000000000000000000000000000000000000001",
  repoOwner: "antfleet",
  repoName: "x402-fixture",
  prNumber: 1,
  sha: "abc1234",
  idempotencyKey: "key",
  status: "queued",
  failureMode: null,
  failureMessage: null,
  result: null,
  debitPaymentId: null,
  refundPaymentId: null,
  callerWallet: "0x0000000000000000000000000000000000000001",
  paymentRail: "x402" as const,
  x402PayTo: "0x000000000000000000000000000000000000dEaD",
  x402PaymentPayload: authorizationState,
  x402ValidAfter: new Date(authorizationState.validAfter),
  x402ValidBefore: new Date(authorizationState.validBefore),
  x402ReviewId: null,
  x402SettlementStatus: "pending" as const,
  x402SettlementResponse: null,
  createdAt: new Date("2026-05-29T00:00:00Z"),
  startedAt: null,
  completedAt: null,
  expiresAt: new Date("2026-05-30T00:00:00Z"),
};

describe("processReviewJob x402 settlement lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMocks.getReviewJob.mockResolvedValue(x402Job);
    queryMocks.markJobRunning.mockResolvedValue(true);
    dbQueryMocks.hashRepo.mockReturnValue("repo-hash");
    dbQueryMocks.enqueueReview.mockResolvedValue({ reviewId: "review-1", isNew: false });
    dbQueryMocks.loadPrivateDisclosureFindingIndexes.mockResolvedValue([]);
    publicFilesMocks.getPublicChangedFiles.mockResolvedValue([
      { filename: "src/index.ts", patch: "@@ -1 +1 @@" },
    ]);
    publicFilesMocks.makePublicOctokit.mockReturnValue({
      rest: {
        git: {
          getCommit: vi.fn().mockResolvedValue({
            data: { tree: { sha: "tree-sha" } },
          }),
          getTree: vi.fn().mockResolvedValue({
            data: {
              tree: [{ path: "app/api/route.ts", type: "blob", size: 64, sha: "file-sha" }],
            },
          }),
        },
        repos: {
          getContent: vi.fn().mockResolvedValue({
            data: {
              type: "file",
              content: Buffer.from(
                "export async function GET() { return Response.json({ ok: true }); }",
              ).toString("base64"),
            },
          }),
        },
      },
    });
    reviewPipelineMocks.reviewPR.mockResolvedValue({
      estimatedCostUsd: 0.25,
      modelIds: { a: "model-a" },
      perProvider: {},
      agreementMode: "unanimous",
      agreed: [],
      disagreements: [],
      degraded: false,
      degradedReason: null,
      totalMs: 100,
    });
    paywallQueryMocks.loadReviewForResponse.mockResolvedValue({
      reviewId: "review-1",
      processingStatus: "done",
    });
    facilitatorMocks.settlePayment.mockResolvedValue({
      settled: true,
      paymentResponseHeader: "header",
      response: { txHash: "0xsettled" },
    });
  });

  it("settles and persists settlement before marking an x402 job complete", async () => {
    const events: string[] = [];
    facilitatorMocks.settlePayment.mockImplementation(async () => {
      events.push("settle");
      return { settled: true, paymentResponseHeader: "header", response: { txHash: "0xsettled" } };
    });
    queryMocks.markX402JobCompleteSettled.mockImplementation(async () => {
      events.push("mark-complete-settled");
    });
    queryMocks.markX402SettlementSettled.mockImplementation(async () => {
      events.push("mark-settled");
    });
    queryMocks.markJobComplete.mockImplementation(async () => {
      events.push("mark-complete");
    });

    const { processReviewJob } = await import("./review-job-worker");
    const outcome = await processReviewJob("job-x402");

    expect(outcome).toEqual({ kind: "complete", jobId: "job-x402" });
    expect(events).toEqual(["settle", "mark-settled", "mark-complete-settled"]);
    expect(queryMocks.markJobComplete).not.toHaveBeenCalled();
    expect(queryMocks.markX402JobFailedWithResultAndSettlement).not.toHaveBeenCalled();
  });

  it("redacts embargoed findings from cached x402 result payloads", async () => {
    const oldDisclosureFlag = process.env["ANTFLEET_DISCLOSURE_GATE"];
    const oldBackfillFlag = process.env["ANTFLEET_DISCLOSURE_BACKFILL_COMPLETE"];
    process.env["ANTFLEET_DISCLOSURE_GATE"] = "true";
    process.env["ANTFLEET_DISCLOSURE_BACKFILL_COMPLETE"] = "true";
    dbQueryMocks.loadPrivateDisclosureFindingIndexes.mockResolvedValue([0]);
    paywallQueryMocks.loadReviewForResponse.mockResolvedValue({
      reviewId: "review-1",
      processingStatus: "done",
      agreementDecision: {
        mode: "unanimous",
        agreed: [
          { title: "Private live-protocol drain", severity: "critical" },
          { title: "Public cleanup", severity: "low" },
        ],
        disagreements: [
          {
            providers: ["anthropic"],
            finding: { title: "Private live-protocol drain", severity: "critical" },
          },
        ],
        degraded: false,
        reachabilityGate: {
          downgrades: [
            { index: 0, reason: "private evidence", originalSeverity: "critical" },
            { index: 1, reason: "public evidence", originalSeverity: "low" },
          ],
          agreedRawByGate: [
            { title: "Private live-protocol drain", severity: "critical" },
            { title: "Public cleanup", severity: "low" },
          ],
        },
      },
      findingIds: ["review-1-0", "review-1-1"],
    });

    try {
      const { processReviewJob } = await import("./review-job-worker");
      await processReviewJob("job-x402");

      const result = queryMocks.markX402JobCompleteSettled.mock.calls[0]?.[2] as Record<
        string,
        unknown
      >;
      const agreement = result["agreementDecision"] as Record<string, unknown>;
      expect(agreement["agreed"]).toEqual([{ title: "Public cleanup", severity: "low" }]);
      expect(agreement["disagreements"]).toBeUndefined();
      expect(
        (agreement["reachabilityGate"] as Record<string, unknown>)["agreedRawByGate"],
      ).toBeUndefined();
      expect((agreement["reachabilityGate"] as Record<string, unknown>)["downgrades"]).toEqual([
        { index: 0, reason: "public evidence", originalSeverity: "low" },
      ]);
      expect(agreement["disclosure"]).toMatchObject({ withheldFindings: 1 });
      expect(result["findingIds"]).toEqual(["review-1-1"]);
    } finally {
      if (oldDisclosureFlag === undefined) delete process.env["ANTFLEET_DISCLOSURE_GATE"];
      else process.env["ANTFLEET_DISCLOSURE_GATE"] = oldDisclosureFlag;
      if (oldBackfillFlag === undefined) {
        delete process.env["ANTFLEET_DISCLOSURE_BACKFILL_COMPLETE"];
      } else {
        process.env["ANTFLEET_DISCLOSURE_BACKFILL_COMPLETE"] = oldBackfillFlag;
      }
    }
  });

  it("marks settlement_failed and fails the job when post-review settlement fails", async () => {
    queryMocks.getReviewJob
      .mockResolvedValueOnce(x402Job)
      .mockResolvedValueOnce({ ...x402Job, x402ReviewId: "review-1" });
    facilitatorMocks.settlePayment.mockRejectedValue(new Error("settle rejected"));

    const { processReviewJob } = await import("./review-job-worker");
    const outcome = await processReviewJob("job-x402");

    expect(outcome).toMatchObject({ kind: "failed", jobId: "job-x402", failureMode: "internal" });
    expect(queryMocks.markX402JobCompleteSettled).not.toHaveBeenCalled();
    expect(queryMocks.markX402SettlementFailed).toHaveBeenCalledWith(
      {},
      "job-x402",
      expect.objectContaining({ code: "x402_settle_failed" }),
    );
    expect(queryMocks.markX402JobFailedWithResultAndSettlement).toHaveBeenCalledWith(
      {},
      "job-x402",
      "internal",
      "An internal error occurred while settling the x402 payment.",
      expect.objectContaining({
        paid_via: "x402",
        reviewId: "review-1",
        settlement_status: "settlement_failed",
      }),
      "settlement_failed",
      expect.objectContaining({ code: "x402_settle_failed" }),
      expect.any(Date),
    );
  });

  it("does not downgrade a job that was already settled before a terminal update failed", async () => {
    queryMocks.getReviewJob.mockResolvedValueOnce(x402Job).mockResolvedValueOnce({
      ...x402Job,
      x402ReviewId: "review-1",
      x402SettlementStatus: "settled",
      x402SettlementResponse: { transaction: "0xsettled" },
    });
    queryMocks.markX402JobCompleteSettled.mockRejectedValue(new Error("db write failed"));

    const { processReviewJob } = await import("./review-job-worker");
    const outcome = await processReviewJob("job-x402");

    expect(outcome).toMatchObject({ kind: "failed", jobId: "job-x402", failureMode: "internal" });
    expect(queryMocks.markX402SettlementNotSettled).not.toHaveBeenCalled();
    expect(queryMocks.markX402SettlementFailed).not.toHaveBeenCalled();
    expect(queryMocks.markX402JobFailedWithResultAndSettlement).toHaveBeenCalledWith(
      {},
      "job-x402",
      "internal",
      "An internal error occurred after x402 payment settlement. The receipt is preserved.",
      expect.objectContaining({ settlement_status: "settled" }),
      "settled",
      { transaction: "0xsettled" },
      expect.any(Date),
    );
  });

  it("preserves a captured settlement when the terminal completion write fails", async () => {
    const events: string[] = [];
    queryMocks.getReviewJob.mockResolvedValueOnce(x402Job).mockResolvedValueOnce({
      ...x402Job,
      x402ReviewId: "review-1",
      x402SettlementStatus: "pending",
      x402SettlementResponse: null,
    });
    facilitatorMocks.settlePayment.mockImplementation(async () => {
      events.push("settle");
      return { settled: true, paymentResponseHeader: "header", response: { txHash: "0xsettled" } };
    });
    queryMocks.markX402SettlementSettled.mockImplementation(async () => {
      events.push("mark-settled");
    });
    queryMocks.markX402JobCompleteSettled.mockImplementation(async () => {
      events.push("mark-complete-settled");
      throw new Error("db write failed");
    });

    const { processReviewJob } = await import("./review-job-worker");
    const outcome = await processReviewJob("job-x402");

    expect(outcome).toMatchObject({ kind: "failed", jobId: "job-x402", failureMode: "internal" });
    expect(events).toEqual(["settle", "mark-settled", "mark-complete-settled", "mark-settled"]);
    expect(queryMocks.markX402SettlementNotSettled).not.toHaveBeenCalled();
    expect(queryMocks.markX402SettlementFailed).not.toHaveBeenCalled();
    expect(queryMocks.markX402JobFailedWithResultAndSettlement).toHaveBeenCalledWith(
      {},
      "job-x402",
      "internal",
      "An internal error occurred after x402 payment settlement. The receipt is preserved.",
      expect.objectContaining({
        reviewId: "review-1",
        settlement_status: "settled",
      }),
      "settled",
      { txHash: "0xsettled" },
      expect.any(Date),
    );
  });

  it("does not settle when x402 review cost exceeds the cap", async () => {
    queryMocks.getReviewJob
      .mockResolvedValueOnce(x402Job)
      .mockResolvedValueOnce({ ...x402Job, x402ReviewId: "review-1" });
    dbQueryMocks.enqueueReview.mockResolvedValue({ reviewId: "review-1", isNew: true });
    reviewPipelineMocks.reviewPR.mockResolvedValue({
      estimatedCostUsd: 1.51,
      modelIds: { a: "model-a" },
      perProvider: {},
      agreementMode: "unanimous",
      agreed: [],
      disagreements: [],
      degraded: false,
      degradedReason: null,
      totalMs: 100,
    });

    const { processReviewJob } = await import("./review-job-worker");
    const outcome = await processReviewJob("job-x402");

    expect(outcome).toMatchObject({
      kind: "failed",
      jobId: "job-x402",
      failureMode: "cost_cap_exceeded",
    });
    expect(facilitatorMocks.settlePayment).not.toHaveBeenCalled();
    expect(queryMocks.markX402SettlementNotSettled).toHaveBeenCalledWith({}, "job-x402");
    expect(queryMocks.markX402JobFailedWithResultAndSettlement).toHaveBeenCalledWith(
      {},
      "job-x402",
      "cost_cap_exceeded",
      "The review exceeded the inference cost cap. The x402 payment was not settled.",
      expect.objectContaining({
        paid_via: "x402",
        reviewId: "review-1",
        settlement_status: "not_settled",
      }),
      "not_settled",
      null,
      expect.any(Date),
    );
  });

  it("generates a first repo threat model from a public repo snapshot on x402", async () => {
    const oldFlag = process.env["ANTFLEET_THREAT_MODEL"];
    process.env["ANTFLEET_THREAT_MODEL"] = "true";
    try {
      dbQueryMocks.enqueueReview.mockResolvedValue({ reviewId: "review-1", isNew: true });
      dbQueryMocks.loadRepoThreatModel.mockResolvedValue(null);
      dbQueryMocks.upsertRepoThreatModel.mockResolvedValue(undefined);

      const { processReviewJob } = await import("./review-job-worker");
      await processReviewJob("job-x402");

      expect(publicFilesMocks.makePublicOctokit).toHaveBeenCalled();
      expect(dbQueryMocks.upsertRepoThreatModel).toHaveBeenCalledTimes(1);
      expect(dbQueryMocks.upsertRepoThreatModel).toHaveBeenCalledWith(
        expect.objectContaining({
          repoHash: "repo-hash",
          publicAccess: "public",
          model: expect.objectContaining({
            sections: expect.objectContaining({
              entryPoints: expect.objectContaining({ items: expect.any(Array) }),
            }),
          }),
        }),
      );
    } finally {
      if (oldFlag === undefined) delete process.env["ANTFLEET_THREAT_MODEL"];
      else process.env["ANTFLEET_THREAT_MODEL"] = oldFlag;
    }
  });

  it("fails x402 reviews with timeout and skips settlement when reviewPR exceeds wall-clock limit", async () => {
    vi.useFakeTimers();
    const oldTimeout = process.env["X402_MAX_TIMEOUT_SECONDS"];
    process.env["X402_MAX_TIMEOUT_SECONDS"] = "1";
    try {
      queryMocks.getReviewJob
        .mockResolvedValueOnce(x402Job)
        .mockResolvedValueOnce({ ...x402Job, x402ReviewId: "review-1" });
      dbQueryMocks.enqueueReview.mockResolvedValue({ reviewId: "review-1", isNew: true });
      let signal: AbortSignal | undefined;
      reviewPipelineMocks.reviewPR.mockImplementation((args: { signal?: AbortSignal }) => {
        signal = args.signal;
        return new Promise(() => {});
      });

      const { processReviewJob } = await import("./review-job-worker");
      const pending = processReviewJob("job-x402");
      await vi.advanceTimersByTimeAsync(1000);
      const outcome = await pending;

      expect(outcome).toMatchObject({ kind: "failed", failureMode: "timeout" });
      expect(signal?.aborted).toBe(true);
      expect(facilitatorMocks.settlePayment).not.toHaveBeenCalled();
      expect(queryMocks.markX402JobFailedWithResultAndSettlement).toHaveBeenCalledWith(
        {},
        "job-x402",
        "timeout",
        "The review timed out. The x402 payment was not settled.",
        expect.objectContaining({ settlement_status: "not_settled" }),
        "not_settled",
        null,
        expect.any(Date),
      );
    } finally {
      vi.useRealTimers();
      if (oldTimeout === undefined) delete process.env["X402_MAX_TIMEOUT_SECONDS"];
      else process.env["X402_MAX_TIMEOUT_SECONDS"] = oldTimeout;
    }
  });
});
