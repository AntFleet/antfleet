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

  it("releases a terminally-failed target holder and retries the insert (M5)", async () => {
    const newRow = { ...existingAcpRow, jobId: "af-new-target", acpJobId: "new-marketplace-job" };
    // findAcpJobByAcpJobId → none; findAcpJobByTargetKey (excludes failed) → none;
    // insert → ON CONFLICT no row (stale failed holder still owns the key);
    // releaseTerminalAcpTargetKey → released one; retry insert → new row.
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // findAcpJobByAcpJobId
      .mockResolvedValueOnce([]) // findAcpJobByTargetKey (pre-insert)
      .mockResolvedValueOnce([]) // insert → conflict, no row
      .mockResolvedValueOnce([{ job_id: "af-old-failed" }]) // releaseTerminalAcpTargetKey
      .mockResolvedValueOnce([newRow]); // retry insert → created

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

    expect(result).toEqual({ row: newRow, created: true });
    // 5 execute calls = acpJobId lookup, target lookup, insert (conflict),
    // release, retry insert — proves the release-and-retry path fired.
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it("does not release an ACTIVE holder; returns the in-flight job as existing (M5)", async () => {
    // The pre-insert target lookup misses (TOCTOU: active holder appeared after),
    // the insert conflicts, releaseTerminalAcpTargetKey finds nothing to release
    // (holder is active, not failed/expired), and the post-insert lookup returns
    // the in-flight job. No new row is created.
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // findAcpJobByAcpJobId
      .mockResolvedValueOnce([]) // findAcpJobByTargetKey (pre-insert)
      .mockResolvedValueOnce([]) // insert → conflict
      .mockResolvedValueOnce([]) // releaseTerminalAcpTargetKey → nothing released
      .mockResolvedValueOnce([]) // findAcpJobByIdempotencyKey
      .mockResolvedValueOnce([existingAcpRow]); // findAcpJobByTargetKey (post-insert)

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
  });

  it("throws a retryable error on an unresolvable (lost-race) conflict (M5)", async () => {
    // Insert conflicts, nothing to release, and neither post-insert finder
    // resolves it — a rare lost-insert race. It must throw a plain (retryable)
    // error so the ACP event inbox retries; it must NOT be tagged non-retryable.
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // findAcpJobByAcpJobId
      .mockResolvedValueOnce([]) // findAcpJobByTargetKey (pre-insert)
      .mockResolvedValueOnce([]) // insert → conflict
      .mockResolvedValueOnce([]) // releaseTerminalAcpTargetKey → nothing
      .mockResolvedValueOnce([]) // findAcpJobByIdempotencyKey
      .mockResolvedValueOnce([]); // findAcpJobByTargetKey (post-insert)

    let thrown: unknown;
    try {
      await createAcpReviewJob(
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
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("idempotency conflict returned no existing row");
    // Deliberately retryable — no non-retryable failureModeTag.
    expect((thrown as { failureModeTag?: unknown }).failureModeTag).toBeUndefined();
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
