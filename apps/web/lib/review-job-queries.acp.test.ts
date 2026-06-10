import { describe, expect, it, vi } from "vitest";
import { claimAcpJobBudgetSetting, createAcpReviewJob } from "./review-job-queries";

const existingAcpRow = {
  jobId: "af-existing-target",
  installationId: "acp",
  walletAddress: "0x1111111111111111111111111111111111111111",
  repoOwner: "AntFleet",
  repoName: "acp-fixture",
  prNumber: 7,
  sha: "4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001",
  idempotencyKey: "acp:old-marketplace-job",
  status: "billing_pending",
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
  acpJobId: "old-marketplace-job",
  acpClientWallet: "0x1111111111111111111111111111111111111111",
  acpTargetKey:
    "acp-target:0x1111111111111111111111111111111111111111:antfleet/acp-fixture:7:4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001",
  acpRequestPayload: {},
  acpReviewId: null,
  acpBudgetStatus: "pending" as const,
  acpBudgetResponse: null,
  acpBudgetAttempts: 0,
  acpBudgetUpdatedAt: null,
  acpSubmitStatus: "pending" as const,
  acpSubmitResponse: null,
  acpSubmittedAt: null,
  createdAt: new Date("2026-06-10T00:00:00Z"),
  startedAt: null,
  completedAt: null,
  expiresAt: new Date("2026-06-11T00:00:00Z"),
};

describe("ACP review job queries", () => {
  it("returns the existing ACP target row before inserting a duplicate target", async () => {
    const execute = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([existingAcpRow]);

    const result = await createAcpReviewJob(
      { execute },
      {
        acpJobId: "new-marketplace-job",
        clientAgentWallet: "0x1111111111111111111111111111111111111111",
        repoOwner: "AntFleet",
        repoName: "acp-fixture",
        prNumber: 7,
        sha: "4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001",
        requestPayload: {} as never,
        targetKey: existingAcpRow.acpTargetKey,
      },
    );

    expect(result).toEqual({ row: existingAcpRow, created: false });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not automatically reclaim stale ACP budget setting rows", async () => {
    const execute = vi.fn().mockResolvedValue([]);

    const claimed = await claimAcpJobBudgetSetting(
      { execute },
      "af-acp-job",
      new Date("2026-06-10T00:00:00Z"),
    );

    expect(claimed).toBe(false);
    expect(String(execute.mock.calls[0]?.[0])).not.toContain("acp_budget_status = 'setting'");
  });
});
