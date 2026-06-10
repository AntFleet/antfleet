import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBudgetedAcpReviewJob,
  parseAcpProviderEvent,
  runFundedAcpReviewJob,
} from "./intake-adapter";

const validRequest = {
  mode: "pr",
  target: { repo: "AntFleet/acp-fixture", pr: 7 },
  client: { agent_wallet: "0x1111111111111111111111111111111111111111" },
  options: { public_receipt: true, max_findings: 10 },
} as const;

describe("ACP intake adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses job.created events with stringified requirements", () => {
    const parsed = parseAcpProviderEvent({
      type: "job.created",
      jobId: "43868",
      requirements: JSON.stringify(validRequest),
    });

    expect(parsed).toMatchObject({
      kind: "job_created",
      acpJobId: "43868",
      clientAgentWallet: "0x1111111111111111111111111111111111111111",
    });
  });

  it("creates billing-pending ACP jobs and proposes the AntFleet review budget once", async () => {
    const createJob = vi.fn().mockResolvedValue({
      row: {
        jobId: "af-acp-job",
        status: "billing_pending",
        paymentRail: "acp",
      },
      created: true,
    });
    const setBudget = vi.fn().mockResolvedValue({ json: { ok: true }, stdout: "{}", stderr: "" });

    const outcome = await createBudgetedAcpReviewJob(
      {
        kind: "job_created",
        acpJobId: "43868",
        request: validRequest,
        clientAgentWallet: "0x1111111111111111111111111111111111111111",
        raw: {},
      },
      { createJob, setBudget, q: {} as never },
    );

    expect(outcome.created).toBe(true);
    expect(createJob).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        acpJobId: "43868",
        repoOwner: "AntFleet",
        repoName: "acp-fixture",
        prNumber: 7,
        sha: null,
        initialStatus: "billing_pending",
      }),
    );
    expect(setBudget).toHaveBeenCalledWith(
      expect.objectContaining({ acpJobId: "43868", amountUsdc: expect.any(String) }),
    );
  });

  it("queues and runs the existing review job on funded events", async () => {
    const findJob = vi.fn().mockResolvedValue({
      jobId: "af-acp-job",
      status: "billing_pending",
      paymentRail: "acp",
    });
    const markQueued = vi.fn().mockResolvedValue(true);
    const processJob = vi.fn().mockResolvedValue({ kind: "complete", jobId: "af-acp-job" });

    const outcome = await runFundedAcpReviewJob("43868", {
      findJob,
      markQueued,
      processJob,
      q: {} as never,
    });

    expect(outcome.queued).toBe(true);
    expect(markQueued).toHaveBeenCalledWith({}, "af-acp-job");
    expect(processJob).toHaveBeenCalledWith("af-acp-job");
  });
});
