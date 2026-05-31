import { describe, expect, it, vi } from "vitest";
import { createReviewJob, createX402ReviewJob } from "./review-job-queries";

const authorizationState = {
  validAfter: "2026-05-29T00:00:00.000Z",
  validBefore: "2026-05-29T00:10:00.000Z",
};

const existingRow = {
  jobId: "job-existing",
  installationId: "x402",
  walletAddress: "0x0000000000000000000000000000000000000001",
  repoOwner: "antfleet",
  repoName: "fixture",
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
  x402ValidAfter: authorizationState.validAfter,
  x402ValidBefore: authorizationState.validBefore,
  x402ReviewId: null,
  x402SettlementStatus: "pending" as const,
  x402SettlementResponse: null,
  createdAt: "2026-05-29T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
  expiresAt: "2026-05-30T00:00:00.000Z",
};

describe("createX402ReviewJob", () => {
  it("returns the existing idempotent x402 job when insert loses a uniqueness race", async () => {
    const q = {
      execute: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([existingRow]),
    };

    const row = await createX402ReviewJob(q, {
      callerWallet: "0x0000000000000000000000000000000000000001",
      repoOwner: "antfleet",
      repoName: "fixture",
      prNumber: 1,
      sha: "abc1234",
      idempotencyKey: "key",
      x402PayTo: "0x000000000000000000000000000000000000dEaD",
      authorizationState,
    });

    expect(q.execute).toHaveBeenCalledTimes(2);
    expect(row.jobId).toBe("job-existing");
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.x402ValidAfter).toBeInstanceOf(Date);
  });
});

describe("createReviewJob", () => {
  it("returns the existing channel job when insert loses an idempotency race", async () => {
    const existingChannelRow = {
      ...existingRow,
      jobId: "job-channel-existing",
      installationId: "install-1",
      walletAddress: "0x0000000000000000000000000000000000000002",
      paymentRail: "channel" as const,
      callerWallet: null,
      x402PayTo: null,
      x402PaymentPayload: null,
      x402ValidAfter: null,
      x402ValidBefore: null,
      x402ReviewId: null,
      x402SettlementStatus: null,
      x402SettlementResponse: null,
    };
    const q = {
      execute: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([existingChannelRow]),
    };

    const result = await createReviewJob(q, {
      installationId: "install-1",
      walletAddress: "0x0000000000000000000000000000000000000002",
      repoOwner: "antfleet",
      repoName: "fixture",
      prNumber: 1,
      sha: "abc1234",
      idempotencyKey: "key",
      debitPaymentId: null,
      initialStatus: "billing_pending",
    });

    expect(q.execute).toHaveBeenCalledTimes(2);
    expect(result.created).toBe(false);
    expect(result.row.jobId).toBe("job-channel-existing");
    expect(result.row.paymentRail).toBe("channel");
  });
});
