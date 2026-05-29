import { describe, expect, it, vi } from "vitest";
import { handleX402PollRequest, type X402PollDeps } from "./route";
import type { ReviewJobRow } from "@/lib/review-job-queries";

const NOW = new Date("2026-05-29T00:10:00Z");

function job(overrides: Partial<ReviewJobRow> = {}): ReviewJobRow {
  return {
    jobId: "job-x402",
    installationId: "x402",
    walletAddress: "0x0000000000000000000000000000000000000001",
    repoOwner: "antfleet",
    repoName: "x402-fixture",
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
    x402ValidAfter: new Date("2026-05-29T00:00:00Z"),
    x402ValidBefore: new Date("2026-05-29T00:20:00Z"),
    x402ReviewId: "review-1",
    x402SettlementStatus: "pending",
    x402SettlementResponse: null,
    createdAt: new Date("2026-05-29T00:00:00Z"),
    startedAt: new Date("2026-05-29T00:00:01Z"),
    completedAt: null,
    expiresAt: new Date("2026-05-30T00:00:00Z"),
    ...overrides,
  };
}

function deps(overrides: Partial<X402PollDeps> = {}): X402PollDeps {
  return {
    getReviewJob: vi.fn(async () => job()),
    markExpired: vi.fn(async () => null),
    now: () => NOW,
    ...overrides,
  };
}

const ctx = { params: Promise.resolve({ jobId: "job-x402" }) };

describe("GET /api/v1/review/x402/{jobId}", () => {
  it("attaches PAYMENT-RESPONSE on terminal settled responses", async () => {
    const settlement = { success: true, transaction: "0xsettled" };
    const res = await handleX402PollRequest(
      ctx,
      deps({
        getReviewJob: vi.fn(async () =>
          job({
            status: "complete",
            result: { reviewId: "review-1" },
            x402SettlementStatus: "settled",
            x402SettlementResponse: settlement,
          }),
        ),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("PAYMENT-RESPONSE")).toBe(
      Buffer.from(JSON.stringify(settlement)).toString("base64"),
    );
    expect(res.headers.get("Access-Control-Expose-Headers")).toBe("PAYMENT-RESPONSE");
  });

  it("does not attach PAYMENT-RESPONSE before settlement", async () => {
    const res = await handleX402PollRequest(ctx, deps());

    expect(res.status).toBe(200);
    expect(res.headers.get("PAYMENT-RESPONSE")).toBeNull();
  });

  it("lazily expires in-flight jobs whose authorization window elapsed", async () => {
    const expired = job({
      status: "expired",
      x402SettlementStatus: "not_settled",
      x402ValidBefore: new Date("2026-05-29T00:05:00Z"),
      completedAt: NOW,
    });
    const markExpired = vi.fn(async () => expired);
    const res = await handleX402PollRequest(
      ctx,
      deps({
        getReviewJob: vi.fn(async () =>
          job({ status: "queued", x402ValidBefore: new Date("2026-05-29T00:05:00Z") }),
        ),
        markExpired,
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: "expired",
      settlementStatus: "not_settled",
    });
    expect(markExpired).toHaveBeenCalledWith("job-x402", NOW);
    expect(res.headers.get("PAYMENT-RESPONSE")).toBeNull();
  });
});
