import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMocks = vi.hoisted(() => ({
  findStaleQueuedJobs: vi.fn(),
  findStuckRunningJobs: vi.fn(),
  markJobFailed: vi.fn(),
  markX402JobFailedWithResultAndSettlement: vi.fn(),
  purgeExpiredJobResults: vi.fn(),
}));

const refundMocks = vi.hoisted(() => ({
  refundJobChannelDebit: vi.fn(),
}));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/review-job-queries", () => queryMocks);
vi.mock("@/lib/review-job-worker", () => ({ processReviewJob: vi.fn() }));
vi.mock("@/lib/paywall/refund", () => refundMocks);
vi.mock("@/lib/log", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  messageOf: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

const baseJob = {
  jobId: "job-x402",
  installationId: "x402",
  walletAddress: "0x0000000000000000000000000000000000000001",
  repoOwner: "antfleet",
  repoName: "fixture",
  prNumber: 1,
  sha: "abc1234",
  idempotencyKey: "key",
  status: "running",
  failureMode: null,
  failureMessage: null,
  result: null,
  debitPaymentId: null,
  refundPaymentId: null,
  callerWallet: "0x0000000000000000000000000000000000000001",
  paymentRail: "x402" as const,
  x402PayTo: "0x000000000000000000000000000000000000dEaD",
  x402PaymentPayload: null,
  x402ValidAfter: null,
  x402ValidBefore: null,
  x402ReviewId: "review-1",
  x402SettlementStatus: "pending" as const,
  x402SettlementResponse: null,
  createdAt: new Date("2026-05-29T00:00:00Z"),
  startedAt: new Date("2026-05-29T00:01:00Z"),
  completedAt: null,
  expiresAt: new Date("2026-05-30T00:00:00Z"),
};

describe("review jobs cron timeout terminalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks stuck x402 jobs not_settled without invoking channel refund", async () => {
    const { timeoutStuckReviewJob } = await import("./route");

    await timeoutStuckReviewJob(baseJob, new Date("2026-05-29T00:12:00Z"));

    expect(queryMocks.markJobFailed).not.toHaveBeenCalled();
    expect(refundMocks.refundJobChannelDebit).not.toHaveBeenCalled();
    expect(queryMocks.markX402JobFailedWithResultAndSettlement).toHaveBeenCalledWith(
      {},
      "job-x402",
      "timeout",
      "The review timed out. The x402 payment was not settled.",
      {
        paid_via: "x402",
        settlement_status: "not_settled",
        reviewId: "review-1",
        receipt_url: "/receipts/review/review-1",
      },
      "not_settled",
      null,
      expect.any(Date),
    );
  });

  it("preserves prior x402 settlement failure evidence on cron timeout", async () => {
    const { timeoutStuckReviewJob } = await import("./route");
    const settlementResponse = { code: "x402_settle_failed", message: "facilitator rejected" };

    await timeoutStuckReviewJob(
      {
        ...baseJob,
        x402SettlementStatus: "settlement_failed",
        x402SettlementResponse: settlementResponse,
      },
      new Date("2026-05-29T00:12:00Z"),
    );

    expect(queryMocks.markX402JobFailedWithResultAndSettlement).toHaveBeenCalledWith(
      {},
      "job-x402",
      "timeout",
      "An internal error occurred while settling the x402 payment.",
      expect.objectContaining({
        paid_via: "x402",
        settlement_status: "settlement_failed",
      }),
      "settlement_failed",
      settlementResponse,
      expect.any(Date),
    );
  });
});
