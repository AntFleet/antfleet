import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBudgetedAcpReviewJob,
  handleAcpProviderEvent,
  parseAcpProviderEvent,
  runFundedAcpReviewJob,
  validateAcpReviewTarget,
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
    delete process.env["ACP_REVIEW_PRICE_USDC"];
  });

  it("parses job.created events with stringified requirements", () => {
    const parsed = parseAcpProviderEvent({
      type: "job.created",
      jobId: "43868",
      clientAgentWallet: "0x2222222222222222222222222222222222222222",
      requirements: JSON.stringify(validRequest),
    });

    expect(parsed).toMatchObject({
      kind: "job_created",
      acpJobId: "43868",
      clientAgentWallet: "0x2222222222222222222222222222222222222222",
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
    const claimBudgetSetting = vi.fn().mockResolvedValue(true);
    const markBudgetSet = vi.fn().mockResolvedValue(undefined);
    const markBudgetFailed = vi.fn().mockResolvedValue(undefined);
    const validateTarget = vi.fn().mockResolvedValue({
      owner: "AntFleet",
      repo: "acp-fixture",
      prNumber: 7,
      sha: "4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001",
    });

    const outcome = await createBudgetedAcpReviewJob(
      {
        kind: "job_created",
        acpJobId: "43868",
        request: validRequest,
        clientAgentWallet: "0x1111111111111111111111111111111111111111",
        raw: {},
      },
      {
        createJob,
        setBudget,
        claimBudgetSetting,
        markBudgetSet,
        markBudgetFailed,
        validateTarget,
        q: {} as never,
      },
    );

    expect(outcome.created).toBe(true);
    expect(createJob).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        acpJobId: "43868",
        repoOwner: "AntFleet",
        repoName: "acp-fixture",
        prNumber: 7,
        sha: "4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001",
        idempotencyKey: "acp:43868",
        targetKey:
          "acp-target:0x1111111111111111111111111111111111111111:antfleet/acp-fixture:7:4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001",
        initialStatus: "billing_pending",
      }),
    );
    expect(claimBudgetSetting).toHaveBeenCalledWith({}, "af-acp-job", expect.any(Date));
    expect(setBudget).toHaveBeenCalledWith(
      expect.objectContaining({ acpJobId: "43868", amountUsdc: "1.00" }),
    );
    expect(markBudgetSet).toHaveBeenCalledWith({}, "af-acp-job", { ok: true }, expect.any(Date));
    expect(markBudgetFailed).not.toHaveBeenCalled();
  });

  it("retries budget setup for existing billing-pending ACP jobs", async () => {
    const createJob = vi.fn().mockResolvedValue({
      row: {
        jobId: "af-acp-job",
        status: "billing_pending",
        paymentRail: "acp",
        acpBudgetStatus: "set_failed",
      },
      created: false,
    });
    const setBudget = vi.fn().mockResolvedValue({ json: { ok: true }, stdout: "{}", stderr: "" });
    const claimBudgetSetting = vi.fn().mockResolvedValue(true);
    const markBudgetSet = vi.fn().mockResolvedValue(undefined);
    const validateTarget = vi.fn().mockResolvedValue({
      owner: "AntFleet",
      repo: "acp-fixture",
      prNumber: 7,
      sha: "4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001",
    });

    const outcome = await createBudgetedAcpReviewJob(
      {
        kind: "job_created",
        acpJobId: "43868",
        request: validRequest,
        clientAgentWallet: "0x1111111111111111111111111111111111111111",
        raw: {},
      },
      { createJob, setBudget, claimBudgetSetting, markBudgetSet, validateTarget, q: {} as never },
    );

    expect(outcome.created).toBe(false);
    expect(setBudget).toHaveBeenCalledTimes(1);
    expect(markBudgetSet).toHaveBeenCalledWith({}, "af-acp-job", { ok: true }, expect.any(Date));
  });

  it("does not mark budget failed after an external budget success if DB set persistence fails", async () => {
    const createJob = vi.fn().mockResolvedValue({
      row: {
        jobId: "af-acp-job",
        status: "billing_pending",
        paymentRail: "acp",
      },
      created: true,
    });
    const setBudget = vi.fn().mockResolvedValue({ json: { ok: true }, stdout: "{}", stderr: "" });
    const claimBudgetSetting = vi.fn().mockResolvedValue(true);
    const markBudgetSet = vi.fn().mockRejectedValue(new Error("db unavailable"));
    const markBudgetFailed = vi.fn().mockResolvedValue(undefined);
    const markBudgetReconciliationRequired = vi.fn().mockResolvedValue(undefined);
    const validateTarget = vi.fn().mockResolvedValue({
      owner: "AntFleet",
      repo: "acp-fixture",
      prNumber: 7,
      sha: "4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001",
    });

    await expect(
      createBudgetedAcpReviewJob(
        {
          kind: "job_created",
          acpJobId: "43868",
          request: validRequest,
          clientAgentWallet: "0x1111111111111111111111111111111111111111",
          raw: {},
        },
        {
          createJob,
          setBudget,
          claimBudgetSetting,
          markBudgetSet,
          markBudgetFailed,
          markBudgetReconciliationRequired,
          validateTarget,
          q: {} as never,
        },
      ),
    ).rejects.toThrow("db unavailable");

    expect(setBudget).toHaveBeenCalledTimes(1);
    expect(markBudgetFailed).not.toHaveBeenCalled();
    expect(markBudgetReconciliationRequired).toHaveBeenCalledWith(
      {},
      "af-acp-job",
      expect.objectContaining({
        budget: { ok: true },
        persistenceError: "db unavailable",
      }),
      expect.any(Date),
    );
  });

  it("does not reissue budget setup for rows requiring budget reconciliation", async () => {
    const createJob = vi.fn().mockResolvedValue({
      row: {
        jobId: "af-acp-job",
        status: "billing_pending",
        paymentRail: "acp",
        acpBudgetStatus: "set_reconcile",
      },
      created: false,
    });
    const setBudget = vi.fn();
    const claimBudgetSetting = vi.fn();
    const validateTarget = vi.fn().mockResolvedValue({
      owner: "AntFleet",
      repo: "acp-fixture",
      prNumber: 7,
      sha: "4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001",
    });

    const outcome = await createBudgetedAcpReviewJob(
      {
        kind: "job_created",
        acpJobId: "43868",
        request: validRequest,
        clientAgentWallet: "0x1111111111111111111111111111111111111111",
        raw: {},
      },
      { createJob, setBudget, claimBudgetSetting, validateTarget, q: {} as never },
    );

    expect(outcome.budget).toBeNull();
    expect(claimBudgetSetting).not.toHaveBeenCalled();
    expect(setBudget).not.toHaveBeenCalled();
  });

  it("keeps active budget setting rows retryable instead of silently processing the inbox event", async () => {
    const createJob = vi.fn().mockResolvedValue({
      row: {
        jobId: "af-acp-job",
        status: "billing_pending",
        paymentRail: "acp",
        acpBudgetStatus: "setting",
      },
      created: false,
    });
    const claimBudgetSetting = vi.fn().mockResolvedValue(false);
    const setBudget = vi.fn();
    const validateTarget = vi.fn().mockResolvedValue({
      owner: "AntFleet",
      repo: "acp-fixture",
      prNumber: 7,
      sha: "4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001",
    });

    await expect(
      createBudgetedAcpReviewJob(
        {
          kind: "job_created",
          acpJobId: "43868",
          request: validRequest,
          clientAgentWallet: "0x1111111111111111111111111111111111111111",
          raw: {},
        },
        { createJob, claimBudgetSetting, setBudget, validateTarget, q: {} as never },
      ),
    ).rejects.toThrow("ACP budget setup requires operator reconciliation");

    expect(setBudget).not.toHaveBeenCalled();
  });

  it("rejects missing authenticated ACP client wallet metadata", async () => {
    await expect(
      createBudgetedAcpReviewJob(
        {
          kind: "job_created",
          acpJobId: "43868",
          request: validRequest,
          clientAgentWallet: null,
          raw: {},
        },
        { q: {} as never },
      ),
    ).rejects.toThrow("ACP client wallet missing");
  });

  it("rejects fresh ACP jobs when the client wallet is over the ACP limit", async () => {
    const createJob = vi.fn();
    const setBudget = vi.fn();
    const findExistingJob = vi.fn().mockResolvedValue(null);
    const checkWalletRateLimit = vi
      .fn()
      .mockResolvedValue({ ok: false, retryAfterSeconds: 60, limit: 10 });
    const checkRepoCooldown = vi.fn();
    const validateTarget = vi.fn().mockResolvedValue({
      owner: "AntFleet",
      repo: "acp-fixture",
      prNumber: 7,
      sha: "4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001",
    });

    await expect(
      createBudgetedAcpReviewJob(
        {
          kind: "job_created",
          acpJobId: "43868",
          request: validRequest,
          clientAgentWallet: "0x1111111111111111111111111111111111111111",
          raw: {},
        },
        {
          createJob,
          setBudget,
          findExistingJob,
          checkWalletRateLimit,
          checkRepoCooldown,
          validateTarget,
          q: {} as never,
        },
      ),
    ).rejects.toMatchObject({ failureModeTag: "rate_limited", retryAfterSeconds: 60 });

    expect(createJob).not.toHaveBeenCalled();
    expect(setBudget).not.toHaveBeenCalled();
    expect(checkRepoCooldown).not.toHaveBeenCalled();
  });

  it("rejects fresh ACP jobs during the repo cooldown before creating a paid row", async () => {
    const createJob = vi.fn();
    const setBudget = vi.fn();
    const findExistingJob = vi.fn().mockResolvedValue(null);
    const checkWalletRateLimit = vi.fn().mockResolvedValue({ ok: true });
    const checkRepoCooldown = vi
      .fn()
      .mockResolvedValue({ ok: false, retryAfterSeconds: 300, cooldownSeconds: 600 });
    const validateTarget = vi.fn().mockResolvedValue({
      owner: "AntFleet",
      repo: "acp-fixture",
      prNumber: 7,
      sha: "4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001",
    });

    await expect(
      createBudgetedAcpReviewJob(
        {
          kind: "job_created",
          acpJobId: "43868",
          request: validRequest,
          clientAgentWallet: "0x1111111111111111111111111111111111111111",
          raw: {},
        },
        {
          createJob,
          setBudget,
          findExistingJob,
          checkWalletRateLimit,
          checkRepoCooldown,
          validateTarget,
          q: {} as never,
        },
      ),
    ).rejects.toMatchObject({ failureModeTag: "rate_limited", retryAfterSeconds: 300 });

    expect(createJob).not.toHaveBeenCalled();
    expect(setBudget).not.toHaveBeenCalled();
  });

  it("preserves same-acp-job idempotency without consuming wallet or repo cooldown checks", async () => {
    const existing = {
      jobId: "af-acp-job",
      status: "billing_pending",
      paymentRail: "acp",
      acpJobId: "43868",
      acpBudgetStatus: "set",
    };
    const createJob = vi.fn().mockResolvedValue({ row: existing, created: false });
    const setBudget = vi.fn();
    const findExistingJob = vi.fn().mockResolvedValue(existing);
    const checkWalletRateLimit = vi.fn();
    const checkRepoCooldown = vi.fn();
    const validateTarget = vi.fn().mockResolvedValue({
      owner: "AntFleet",
      repo: "acp-fixture",
      prNumber: 7,
      sha: "4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001",
    });

    const outcome = await createBudgetedAcpReviewJob(
      {
        kind: "job_created",
        acpJobId: "43868",
        request: validRequest,
        clientAgentWallet: "0x1111111111111111111111111111111111111111",
        raw: {},
      },
      {
        createJob,
        setBudget,
        findExistingJob,
        checkWalletRateLimit,
        checkRepoCooldown,
        validateTarget,
        q: {} as never,
      },
    );

    expect(outcome.created).toBe(false);
    expect(checkWalletRateLimit).not.toHaveBeenCalled();
    expect(checkRepoCooldown).not.toHaveBeenCalled();
    expect(setBudget).not.toHaveBeenCalled();
  });

  it("rejects a different ACP job id for an already accepted target without setting budget", async () => {
    const createJob = vi.fn().mockResolvedValue({
      row: {
        jobId: "af-existing-target",
        status: "billing_pending",
        paymentRail: "acp",
        acpJobId: "old-marketplace-job",
        acpBudgetStatus: "pending",
      },
      created: false,
    });
    const setBudget = vi.fn();
    const claimBudgetSetting = vi.fn();
    const validateTarget = vi.fn().mockResolvedValue({
      owner: "AntFleet",
      repo: "acp-fixture",
      prNumber: 7,
      sha: "4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001",
    });

    await expect(
      createBudgetedAcpReviewJob(
        {
          kind: "job_created",
          acpJobId: "new-marketplace-job",
          request: validRequest,
          clientAgentWallet: "0x1111111111111111111111111111111111111111",
          raw: {},
        },
        {
          createJob,
          setBudget,
          claimBudgetSetting,
          validateTarget,
          q: {} as never,
        },
      ),
    ).rejects.toMatchObject({
      failureModeTag: "invalid_input",
      existingAcpJobId: "old-marketplace-job",
      incomingAcpJobId: "new-marketplace-job",
    });

    expect(claimBudgetSetting).not.toHaveBeenCalled();
    expect(setBudget).not.toHaveBeenCalled();
  });

  it("rejects trading-code targets without the not-financial-advice acknowledgment", async () => {
    const octokit = fakeTargetOctokit({
      files: ["src/trading/orders.ts", "src/acp-handler.ts"],
    });

    await expect(validateAcpReviewTarget(validRequest, octokit)).rejects.toMatchObject({
      message: "ACP trading-code request requires options.acknowledge_not_financial_advice=true",
      failureModeTag: "invalid_input",
    });
  });

  it("accepts trading-code targets when the request acknowledges the review boundary", async () => {
    const octokit = fakeTargetOctokit({
      files: ["src/strategy/execution.ts"],
    });
    const request = {
      ...validRequest,
      options: {
        ...validRequest.options,
        acknowledge_not_financial_advice: true,
      },
    };

    await expect(validateAcpReviewTarget(request, octokit)).resolves.toMatchObject({
      owner: "AntFleet",
      repo: "acp-fixture",
      prNumber: 7,
      sha: "4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001",
    });
  });

  it("passes top-level job.created dependency overrides into budgeted creation", async () => {
    const createJob = vi.fn().mockResolvedValue({
      row: {
        jobId: "af-acp-job",
        status: "billing_pending",
        paymentRail: "acp",
      },
      created: true,
    });
    const setBudget = vi.fn().mockResolvedValue({ json: { ok: true }, stdout: "{}", stderr: "" });
    const claimBudgetSetting = vi.fn().mockResolvedValue(true);
    const markBudgetSet = vi.fn().mockResolvedValue(undefined);
    const validateTarget = vi.fn().mockResolvedValue({
      owner: "AntFleet",
      repo: "acp-fixture",
      prNumber: 7,
      sha: "4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001",
    });

    await handleAcpProviderEvent(
      {
        type: "job.created",
        jobId: "43868",
        clientAgentWallet: "0x1111111111111111111111111111111111111111",
        requirements: validRequest,
      },
      {
        createJob,
        setBudget,
        claimBudgetSetting,
        markBudgetSet,
        validateTarget,
        q: {} as never,
      },
    );

    expect(validateTarget).toHaveBeenCalledWith(validRequest);
    expect(claimBudgetSetting).toHaveBeenCalledWith({}, "af-acp-job", expect.any(Date));
    expect(markBudgetSet).toHaveBeenCalledWith({}, "af-acp-job", { ok: true }, expect.any(Date));
  });

  it("queues and runs the existing review job on funded events", async () => {
    const findJob = vi.fn().mockResolvedValue({
      jobId: "af-acp-job",
      status: "billing_pending",
      paymentRail: "acp",
    });
    const markAcpFundedAndQueued = vi.fn().mockResolvedValue(true);
    const processJob = vi.fn().mockResolvedValue({ kind: "complete", jobId: "af-acp-job" });

    const outcome = await runFundedAcpReviewJob("43868", {
      findJob,
      markAcpFundedAndQueued,
      processJob,
      q: {} as never,
    });

    expect(outcome.queued).toBe(true);
    expect(markAcpFundedAndQueued).toHaveBeenCalledWith({}, "af-acp-job");
    expect(processJob).toHaveBeenCalledWith("af-acp-job");
  });

  it("keeps funded events retryable until ACP budget state is locally set", async () => {
    const findJob = vi.fn().mockResolvedValue({
      jobId: "af-acp-job",
      status: "billing_pending",
      paymentRail: "acp",
      acpBudgetStatus: "pending",
    });
    const markAcpFundedAndQueued = vi.fn().mockResolvedValue(false);
    const processJob = vi.fn();

    await expect(
      runFundedAcpReviewJob("43868", {
        findJob,
        markAcpFundedAndQueued,
        processJob,
        q: {} as never,
      }),
    ).rejects.toThrow("ACP funded job is not ready to queue");

    expect(processJob).not.toHaveBeenCalled();
  });

  it("treats funded events as idempotent once the review job is already running", async () => {
    const findJob = vi.fn().mockResolvedValue({
      jobId: "af-acp-job",
      status: "running",
      paymentRail: "acp",
    });
    const markAcpFundedAndQueued = vi.fn();
    const processJob = vi.fn();

    const outcome = await runFundedAcpReviewJob("43868", {
      findJob,
      markAcpFundedAndQueued,
      processJob,
      q: {} as never,
    });

    expect(outcome).toMatchObject({ queued: false, worker: null });
    expect(markAcpFundedAndQueued).not.toHaveBeenCalled();
    expect(processJob).not.toHaveBeenCalled();
  });
});

function fakeTargetOctokit(args: {
  files?: string[];
  repoDescription?: string | null;
  repoTopics?: string[];
}) {
  const pullsListFiles = vi.fn();
  return {
    rest: {
      repos: {
        get: vi
          .fn()
          .mockResolvedValueOnce({ data: { private: false } })
          .mockResolvedValueOnce({
            data: {
              private: false,
              name: "acp-fixture",
              description: args.repoDescription ?? null,
              topics: args.repoTopics ?? [],
            },
          }),
      },
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: {
            state: "open",
            head: { sha: "4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001" },
          },
        }),
        list: vi.fn(),
        listFiles: pullsListFiles,
      },
    },
    paginate: vi.fn(async (endpoint: unknown) => {
      if (endpoint === pullsListFiles) {
        return (args.files ?? ["src/acp-handler.ts"]).map((filename) => ({ filename }));
      }
      return [];
    }),
  } as never;
}
