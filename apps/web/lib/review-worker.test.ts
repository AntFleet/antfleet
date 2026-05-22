import { describe, expect, it, vi } from "vitest";
import {
  computeNextRetryAt,
  isTransientError,
  MAX_PROCESSING_ATTEMPTS,
  runReviewWorker,
  type WorkerDeps,
} from "./review-worker";
import type { ReviewQueueRow } from "../db/queries";

const NOW = new Date("2026-05-18T12:00:00Z");

function mkRow(overrides: Partial<ReviewQueueRow> = {}): ReviewQueueRow {
  return {
    reviewId: "rev-1",
    installationId: 132854945,
    owner: "antfleet",
    repo: "aeon-bench",
    prNumber: 17,
    commitSha: "abc123",
    repoHash: "hash-abc",
    prCommentId: null,
    processingStatus: "pending",
    processingAttempts: 0,
    processingStartedAt: null,
    publicReceipt: true,
    isBenchmark: false,
    ...overrides,
  };
}

function mkFinding(overrides: Record<string, unknown> = {}) {
  return {
    title: "Null pointer in handler",
    severity: "high",
    category: "bug",
    reasoning: "Field may be undefined before access.",
    recommendation: "Guard the property read with a null check.",
    evidence: [{ path: "src/handler.ts", startLine: 42, endLine: 50 }],
    ...overrides,
  };
}

function mkBundle(overrides: Record<string, unknown> = {}): {
  perProvider: Array<{
    name: string;
    modelId: string;
    output: { findings: unknown[] } | null;
    error: string | null;
    ms: number;
  }>;
  modelIds: Record<string, string>;
  agreed: ReturnType<typeof mkFinding>[];
  disagreements: unknown[];
  totalMs: number;
  estimatedCostUsd: number;
  agreementMode: "unanimous";
  degraded: boolean;
  degradedReason: null;
} {
  return {
    perProvider: [
      {
        name: "anthropic",
        modelId: "m1",
        output: { findings: [mkFinding()] },
        error: null,
        ms: 1000,
      },
      { name: "openai", modelId: "m2", output: { findings: [mkFinding()] }, error: null, ms: 1100 },
    ],
    modelIds: { anthropic: "m1", openai: "m2" },
    agreed: [mkFinding()],
    disagreements: [],
    totalMs: 2100,
    estimatedCostUsd: 0.05,
    agreementMode: "unanimous",
    degraded: false,
    degradedReason: null,
    ...overrides,
  };
}

function mkDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    getInstallationToken: vi.fn().mockResolvedValue("ghs_token"),
    getChangedFiles: vi
      .fn()
      .mockResolvedValue([{ filename: "src/x.ts", status: "modified", contents: "code" }]),
    reviewPR: vi.fn().mockResolvedValue(mkBundle()),
    postPRComment: vi.fn().mockResolvedValue({ id: 9001, htmlUrl: "https://gh/c/9001" }),
    runFirstReviewSummary: vi.fn().mockResolvedValue(undefined),
    recordPatchProposedEvent: vi.fn().mockResolvedValue(undefined),
    // Patch Agent v1.5 — default: lane disabled (returns null). Tests that
    // exercise the patch path override this with a stub outcome.
    runPatchAgent: vi.fn().mockResolvedValue(null),
    // Patch Agent v1.6 — default: click-apply lane disabled. Tests that
    // exercise the click-apply post path override these.
    isPatchAgentClickApplyEnabledForInstall: vi.fn().mockResolvedValue(false),
    postPatchReviewComment: vi.fn().mockResolvedValue(null),
    recordPatchReviewComment: vi.fn().mockResolvedValue(undefined),
    loadReviewQueueRow: vi.fn().mockResolvedValue(mkRow()),
    claimReviewForProcessing: vi.fn().mockResolvedValue(true),
    updateReview: vi.fn().mockResolvedValue(undefined),
    setReviewComment: vi.fn().mockResolvedValue(undefined),
    recordFindingStatuses: vi.fn().mockResolvedValue(["rev-1-0"]),
    recordPatchDecisions: vi.fn().mockResolvedValue(undefined),
    setReviewPatchCost: vi.fn().mockResolvedValue(undefined),
    markReviewSucceeded: vi.fn().mockResolvedValue(undefined),
    markReviewFailedForRetry: vi.fn().mockResolvedValue(undefined),
    markReviewTerminallyFailed: vi.fn().mockResolvedValue(undefined),
    loadReviewSettlement: vi.fn().mockResolvedValue(null),
    now: () => NOW,
    ...overrides,
  };
}

describe("runReviewWorker", () => {
  it("claims the row, runs the pipeline, posts a comment, and marks done", async () => {
    const deps = mkDeps();
    const outcome = await runReviewWorker("rev-1", "webhook", deps);
    expect(outcome.kind).toBe("done");
    expect(deps.claimReviewForProcessing).toHaveBeenCalledWith({
      reviewId: "rev-1",
      fromStatuses: ["pending"],
      now: NOW,
    });
    expect(deps.reviewPR).toHaveBeenCalledTimes(1);
    expect(deps.postPRComment).toHaveBeenCalledTimes(1);
    expect(deps.setReviewComment).toHaveBeenCalledWith({
      reviewId: "rev-1",
      commentId: 9001,
      commentUrl: "https://gh/c/9001",
    });
    expect(deps.recordFindingStatuses).toHaveBeenCalledTimes(1);
    expect(deps.markReviewSucceeded).toHaveBeenCalledWith({ reviewId: "rev-1", now: NOW });
    expect(deps.markReviewFailedForRetry).not.toHaveBeenCalled();
    expect(deps.markReviewTerminallyFailed).not.toHaveBeenCalled();
  });

  it("cron source may claim from pending, pending_retry, and in_progress", async () => {
    const deps = mkDeps({
      loadReviewQueueRow: vi.fn().mockResolvedValue(mkRow({ processingStatus: "pending_retry" })),
    });
    await runReviewWorker("rev-1", "cron", deps);
    expect(deps.claimReviewForProcessing).toHaveBeenCalledWith({
      reviewId: "rev-1",
      fromStatuses: ["pending", "pending_retry", "in_progress"],
      now: NOW,
    });
  });

  it("skips a row that is already done without re-running the pipeline", async () => {
    const deps = mkDeps({
      loadReviewQueueRow: vi.fn().mockResolvedValue(mkRow({ processingStatus: "done" })),
    });
    const outcome = await runReviewWorker("rev-1", "cron", deps);
    expect(outcome).toEqual({ kind: "skipped", reviewId: "rev-1", reason: "already_done" });
    expect(deps.claimReviewForProcessing).not.toHaveBeenCalled();
    expect(deps.reviewPR).not.toHaveBeenCalled();
  });

  it("skips a row that already has a posted comment and fast-paths it to done", async () => {
    const deps = mkDeps({
      loadReviewQueueRow: vi
        .fn()
        .mockResolvedValue(mkRow({ prCommentId: 8888, processingStatus: "in_progress" })),
    });
    const outcome = await runReviewWorker("rev-1", "cron", deps);
    expect(outcome).toEqual({
      kind: "skipped",
      reviewId: "rev-1",
      reason: "comment_already_posted",
    });
    expect(deps.markReviewSucceeded).toHaveBeenCalledWith({ reviewId: "rev-1", now: NOW });
    expect(deps.reviewPR).not.toHaveBeenCalled();
  });

  it("skips when claim is lost to another worker", async () => {
    const deps = mkDeps({
      claimReviewForProcessing: vi.fn().mockResolvedValue(false),
    });
    const outcome = await runReviewWorker("rev-1", "webhook", deps);
    expect(outcome).toEqual({ kind: "skipped", reviewId: "rev-1", reason: "lost_claim_race" });
    expect(deps.reviewPR).not.toHaveBeenCalled();
  });

  it("terminally fails rows with missing dispatch context", async () => {
    const deps = mkDeps({
      loadReviewQueueRow: vi.fn().mockResolvedValue(mkRow({ installationId: null })),
    });
    const outcome = await runReviewWorker("rev-1", "cron", deps);
    expect(outcome.kind).toBe("failed");
    expect(deps.markReviewTerminallyFailed).toHaveBeenCalledTimes(1);
    expect(deps.claimReviewForProcessing).not.toHaveBeenCalled();
  });

  it("schedules a retry with exponential backoff on transient failure", async () => {
    const deps = mkDeps({
      loadReviewQueueRow: vi.fn().mockResolvedValue(mkRow({ processingAttempts: 0 })),
      reviewPR: vi.fn().mockRejectedValue(new Error("HTTP 429 rate limit exceeded")),
    });
    const outcome = await runReviewWorker("rev-1", "webhook", deps);
    expect(outcome.kind).toBe("retried");
    expect(deps.markReviewFailedForRetry).toHaveBeenCalledTimes(1);
    const args = (deps.markReviewFailedForRetry as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.reviewId).toBe("rev-1");
    // First failure → 60-second backoff.
    expect(args.nextRetryAt.getTime() - NOW.getTime()).toBe(60_000);
    expect(args.error).toContain("429");
    expect(deps.markReviewTerminallyFailed).not.toHaveBeenCalled();
  });

  it("terminally fails after MAX_PROCESSING_ATTEMPTS even on transient errors", async () => {
    const deps = mkDeps({
      loadReviewQueueRow: vi
        .fn()
        .mockResolvedValue(mkRow({ processingAttempts: MAX_PROCESSING_ATTEMPTS - 1 })),
      reviewPR: vi.fn().mockRejectedValue(new Error("HTTP 503 service unavailable")),
    });
    const outcome = await runReviewWorker("rev-1", "cron", deps);
    expect(outcome.kind).toBe("failed");
    expect(deps.markReviewTerminallyFailed).toHaveBeenCalledTimes(1);
    expect(deps.markReviewFailedForRetry).not.toHaveBeenCalled();
  });

  it("persists a skip when no reviewable files are returned, without posting", async () => {
    const deps = mkDeps({
      getChangedFiles: vi.fn().mockResolvedValue([]),
    });
    const outcome = await runReviewWorker("rev-1", "webhook", deps);
    expect(outcome.kind).toBe("done");
    expect(deps.updateReview).toHaveBeenCalledWith(
      "rev-1",
      expect.objectContaining({
        filesReviewed: [],
        providerResponses: { status: "skipped", reason: "no reviewable files" },
      }),
    );
    expect(deps.reviewPR).not.toHaveBeenCalled();
    expect(deps.postPRComment).not.toHaveBeenCalled();
    expect(deps.markReviewSucceeded).toHaveBeenCalledTimes(1);
  });

  it("does not post a comment when the review degrades", async () => {
    const deps = mkDeps({
      reviewPR: vi.fn().mockResolvedValue(mkBundle({ degraded: true, agreed: [] })),
    });
    const outcome = await runReviewWorker("rev-1", "webhook", deps);
    expect(outcome.kind).toBe("done");
    expect(deps.postPRComment).not.toHaveBeenCalled();
    expect(deps.recordFindingStatuses).not.toHaveBeenCalled();
    expect(deps.markReviewSucceeded).toHaveBeenCalledTimes(1);
  });

  // Patch Agent v1.5 — wiring tests. The orchestrator runs between
  // agreement gate and comment post. When it returns null (flag off),
  // the comment shape is byte-identical to pre-sprint behavior.
  describe("patch agent wiring", () => {
    it("calls runPatchAgent with the agreed findings and changed files", async () => {
      const deps = mkDeps();
      await runReviewWorker("rev-1", "webhook", deps);
      expect(deps.runPatchAgent).toHaveBeenCalledTimes(1);
      const args = (deps.runPatchAgent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(args?.reviewId).toBe("rev-1");
      expect(args?.findings).toHaveLength(1);
    });

    it("includes the suggestion block in the comment when patches ship", async () => {
      const deps = mkDeps({
        runPatchAgent: vi.fn().mockResolvedValue({
          decisions: [
            {
              findingId: "rev-1-0",
              patch: "@@ -1,1 +1,1 @@\n-old\n+new\n",
              modelId: "claude-opus-4-7",
              skipReason: null,
            },
          ],
          byIndex: new Map([
            [0, { patch: "@@ -1,1 +1,1 @@\n-old\n+new\n", modelId: "claude-opus-4-7" }],
          ]),
          elapsedMs: 1500,
        }),
      });
      await runReviewWorker("rev-1", "webhook", deps);
      const body = (deps.postPRComment as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].body;
      expect(body).toContain("```suggestion");
      // Suggestion body contains literal replacement text (the new-side
      // line "new"), NOT the unified-diff prefix "+new".
      expect(body).toContain("\nnew\n");
      expect(body).not.toContain("+new");
      expect(body).toContain("Proposed patch (model: claude-opus-4-7)");
    });

    it("persists patch decisions AFTER finding_status rows exist", async () => {
      const calls: string[] = [];
      const deps = mkDeps({
        recordFindingStatuses: vi.fn().mockImplementation(async () => {
          calls.push("recordFindingStatuses");
          return ["rev-1-0"];
        }),
        recordPatchDecisions: vi.fn().mockImplementation(async () => {
          calls.push("recordPatchDecisions");
        }),
        runPatchAgent: vi.fn().mockResolvedValue({
          decisions: [
            {
              findingId: "rev-1-0",
              patch: "-old\n+new\n",
              modelId: "claude-opus-4-7",
              skipReason: null,
            },
          ],
          byIndex: new Map([[0, { patch: "-old\n+new\n", modelId: "claude-opus-4-7" }]]),
          elapsedMs: 1,
        }),
      });
      await runReviewWorker("rev-1", "webhook", deps);
      expect(calls).toEqual(["recordFindingStatuses", "recordPatchDecisions"]);
    });

    it("does not call recordPatchDecisions when runPatchAgent returns null (flag off)", async () => {
      const deps = mkDeps({
        runPatchAgent: vi.fn().mockResolvedValue(null),
      });
      await runReviewWorker("rev-1", "webhook", deps);
      expect(deps.recordPatchDecisions).not.toHaveBeenCalled();
    });

    it("posts findings-only when runPatchAgent throws (does not block comment)", async () => {
      const deps = mkDeps({
        runPatchAgent: vi.fn().mockRejectedValue(new Error("provider 500")),
      });
      const outcome = await runReviewWorker("rev-1", "webhook", deps);
      expect(outcome.kind).toBe("done");
      // Comment still posted with the original findings.
      expect(deps.postPRComment).toHaveBeenCalledTimes(1);
      const body = (deps.postPRComment as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].body;
      expect(body).not.toContain("```suggestion");
      expect(deps.recordPatchDecisions).not.toHaveBeenCalled();
    });

    it("logs but does not throw when recordPatchDecisions fails", async () => {
      const deps = mkDeps({
        recordPatchDecisions: vi.fn().mockRejectedValue(new Error("db down")),
        runPatchAgent: vi.fn().mockResolvedValue({
          decisions: [
            {
              findingId: "rev-1-0",
              patch: "-old\n+new\n",
              modelId: "claude-opus-4-7",
              skipReason: null,
            },
          ],
          byIndex: new Map([[0, { patch: "-old\n+new\n", modelId: "claude-opus-4-7" }]]),
          elapsedMs: 1,
        }),
      });
      const outcome = await runReviewWorker("rev-1", "webhook", deps);
      // The review still completes — the suggestion block was already posted
      // on the PR; losing the DB row is a non-fatal observability gap.
      expect(outcome.kind).toBe("done");
      expect(deps.markReviewSucceeded).toHaveBeenCalledTimes(1);
    });

    it("does not invoke runPatchAgent when the review degrades (skipped before patch lane)", async () => {
      const deps = mkDeps({
        reviewPR: vi.fn().mockResolvedValue(mkBundle({ degraded: true, agreed: [] })),
      });
      await runReviewWorker("rev-1", "webhook", deps);
      expect(deps.runPatchAgent).not.toHaveBeenCalled();
    });

    // PR7 wiring — onboarder event fires per shipped patch.
    it("fires recordPatchProposedEvent for each shipped patch", async () => {
      const deps = mkDeps({
        runPatchAgent: vi.fn().mockResolvedValue({
          decisions: [
            {
              findingId: "rev-1-0",
              patch: "-old\n+new\n",
              modelId: "claude-opus-4-7",
              skipReason: null,
            },
            {
              findingId: "rev-1-1",
              patch: null,
              modelId: null,
              skipReason: "models_disagreed",
            },
          ],
          byIndex: new Map([[0, { patch: "-old\n+new\n", modelId: "claude-opus-4-7" }]]),
          elapsedMs: 1,
        }),
      });
      await runReviewWorker("rev-1", "webhook", deps);
      // One event for the shipped patch; the disagreed one does NOT fire.
      expect(deps.recordPatchProposedEvent).toHaveBeenCalledTimes(1);
      const callArg = (deps.recordPatchProposedEvent as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0];
      expect(callArg?.findingId).toBe("rev-1-0");
      expect(callArg?.modelId).toBe("claude-opus-4-7");
    });
  });

  describe("Patch Agent v1.6 — click-apply review-comment lane", () => {
    const SINGLE_LINE_PATCH = {
      patch: [
        "--- a/src/foo.ts",
        "+++ b/src/foo.ts",
        "@@ -10,1 +10,1 @@",
        "-const x = 1;",
        "+const x = 2;",
        "",
      ].join("\n"),
      modelId: "claude-opus-4-7",
    };

    const SINGLE_LINE_BUNDLE = mkBundle({
      agreed: [
        mkFinding({
          evidence: [{ path: "src/foo.ts", startLine: 10, endLine: 10 }],
        }),
      ],
    });

    const PATCH_OUTCOME = {
      decisions: [
        {
          findingId: "rev-1-0",
          patch: SINGLE_LINE_PATCH.patch,
          modelId: SINGLE_LINE_PATCH.modelId,
          skipReason: null,
        },
      ],
      byIndex: new Map([[0, SINGLE_LINE_PATCH]]),
      elapsedMs: 1,
    };

    it("posts the review comment and persists id/url when flag is on + single-line evidence", async () => {
      const deps = mkDeps({
        reviewPR: vi.fn().mockResolvedValue(SINGLE_LINE_BUNDLE),
        runPatchAgent: vi.fn().mockResolvedValue(PATCH_OUTCOME),
        isPatchAgentClickApplyEnabledForInstall: vi.fn().mockResolvedValue(true),
        postPatchReviewComment: vi.fn().mockResolvedValue({
          id: 7777,
          url: "https://gh/pull/17#r7777",
        }),
      });
      await runReviewWorker("rev-1", "webhook", deps);
      expect(deps.postPatchReviewComment).toHaveBeenCalledTimes(1);
      const postArg = (deps.postPatchReviewComment as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(postArg.installationId).toBe(132854945);
      expect(postArg.owner).toBe("antfleet");
      expect(postArg.repo).toBe("aeon-bench");
      expect(postArg.pullNumber).toBe(17);
      expect(postArg.commitId).toBe("abc123");
      expect(postArg.path).toBe("src/foo.ts");
      expect(postArg.line).toBe(10);
      expect(postArg.patch).toEqual(SINGLE_LINE_PATCH);
      expect(deps.recordPatchReviewComment).toHaveBeenCalledTimes(1);
      const persistArg = (deps.recordPatchReviewComment as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0];
      expect(persistArg.findingId).toBe("rev-1-0");
      expect(persistArg.reviewCommentId).toBe(7777);
      expect(persistArg.reviewCommentUrl).toBe("https://gh/pull/17#r7777");
    });

    it("renders the issue comment in click-apply shape (one-liner pointer, no <details>) when flag on", async () => {
      const deps = mkDeps({
        reviewPR: vi.fn().mockResolvedValue(SINGLE_LINE_BUNDLE),
        runPatchAgent: vi.fn().mockResolvedValue(PATCH_OUTCOME),
        isPatchAgentClickApplyEnabledForInstall: vi.fn().mockResolvedValue(true),
        postPatchReviewComment: vi.fn().mockResolvedValue({ id: 1, url: "u" }),
      });
      await runReviewWorker("rev-1", "webhook", deps);
      const body = (deps.postPRComment as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].body;
      expect(body).toContain("→ Proposed patch as a reviewable comment below");
      expect(body).not.toContain("<details>");
    });

    it("does not post review comment when flag off (v1.5 byte-identical issue comment)", async () => {
      const deps = mkDeps({
        reviewPR: vi.fn().mockResolvedValue(SINGLE_LINE_BUNDLE),
        runPatchAgent: vi.fn().mockResolvedValue(PATCH_OUTCOME),
        isPatchAgentClickApplyEnabledForInstall: vi.fn().mockResolvedValue(false),
      });
      await runReviewWorker("rev-1", "webhook", deps);
      expect(deps.postPatchReviewComment).not.toHaveBeenCalled();
      expect(deps.recordPatchReviewComment).not.toHaveBeenCalled();
      const body = (deps.postPRComment as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].body;
      expect(body).toContain("<details>");
    });

    it("does not post review comment when evidence is multi-line (Q2 fallback)", async () => {
      const multiLineBundle = mkBundle({
        agreed: [mkFinding({ evidence: [{ path: "src/foo.ts", startLine: 10, endLine: 20 }] })],
      });
      const deps = mkDeps({
        reviewPR: vi.fn().mockResolvedValue(multiLineBundle),
        runPatchAgent: vi.fn().mockResolvedValue(PATCH_OUTCOME),
        isPatchAgentClickApplyEnabledForInstall: vi.fn().mockResolvedValue(true),
      });
      await runReviewWorker("rev-1", "webhook", deps);
      expect(deps.postPatchReviewComment).not.toHaveBeenCalled();
      const body = (deps.postPRComment as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].body;
      // Multi-line evidence stays on the v1.5 <details> path even with the flag on
      expect(body).toContain("<details>");
    });

    it("does not persist when post returns null (no orphan DB row)", async () => {
      const deps = mkDeps({
        reviewPR: vi.fn().mockResolvedValue(SINGLE_LINE_BUNDLE),
        runPatchAgent: vi.fn().mockResolvedValue(PATCH_OUTCOME),
        isPatchAgentClickApplyEnabledForInstall: vi.fn().mockResolvedValue(true),
        postPatchReviewComment: vi.fn().mockResolvedValue(null),
      });
      await runReviewWorker("rev-1", "webhook", deps);
      expect(deps.postPatchReviewComment).toHaveBeenCalledTimes(1);
      expect(deps.recordPatchReviewComment).not.toHaveBeenCalled();
    });

    it("does not block when post throws (caught, logged, issue comment still succeeds)", async () => {
      const deps = mkDeps({
        reviewPR: vi.fn().mockResolvedValue(SINGLE_LINE_BUNDLE),
        runPatchAgent: vi.fn().mockResolvedValue(PATCH_OUTCOME),
        isPatchAgentClickApplyEnabledForInstall: vi.fn().mockResolvedValue(true),
        postPatchReviewComment: vi.fn().mockRejectedValue(new Error("octokit 500")),
      });
      const outcome = await runReviewWorker("rev-1", "webhook", deps);
      expect(outcome.kind).toBe("done");
      expect(deps.markReviewSucceeded).toHaveBeenCalledTimes(1);
      expect(deps.postPRComment).toHaveBeenCalledTimes(1);
      expect(deps.recordPatchReviewComment).not.toHaveBeenCalled();
    });

    it("falls back to v1.5 shape when click-apply gate lookup throws (conservative default)", async () => {
      const deps = mkDeps({
        reviewPR: vi.fn().mockResolvedValue(SINGLE_LINE_BUNDLE),
        runPatchAgent: vi.fn().mockResolvedValue(PATCH_OUTCOME),
        isPatchAgentClickApplyEnabledForInstall: vi.fn().mockRejectedValue(new Error("db down")),
      });
      await runReviewWorker("rev-1", "webhook", deps);
      expect(deps.postPatchReviewComment).not.toHaveBeenCalled();
      const body = (deps.postPRComment as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].body;
      expect(body).toContain("<details>");
    });

    it("does not invoke the click-apply gate when no patches shipped (skips DB call)", async () => {
      const deps = mkDeps({
        reviewPR: vi.fn().mockResolvedValue(SINGLE_LINE_BUNDLE),
        runPatchAgent: vi.fn().mockResolvedValue({
          decisions: [
            { findingId: "rev-1-0", patch: null, modelId: null, skipReason: "models_disagreed" },
          ],
          byIndex: new Map(),
          elapsedMs: 1,
        }),
      });
      await runReviewWorker("rev-1", "webhook", deps);
      expect(deps.isPatchAgentClickApplyEnabledForInstall).not.toHaveBeenCalled();
      expect(deps.postPatchReviewComment).not.toHaveBeenCalled();
    });

    // Audit M1: previously-missing test for "flag ON, decisions present
    // but byIndex empty (all skipped)". Worker should evaluate the gate
    // (decisions.length > 0) but skip both the post loop and the
    // patch_proposed events that depend on a shipped patch.
    it("does not post when flag on but every decision was skipped (empty byIndex)", async () => {
      const deps = mkDeps({
        reviewPR: vi.fn().mockResolvedValue(SINGLE_LINE_BUNDLE),
        runPatchAgent: vi.fn().mockResolvedValue({
          decisions: [
            { findingId: "rev-1-0", patch: null, modelId: null, skipReason: "size_cap" },
            { findingId: "rev-1-1", patch: null, modelId: null, skipReason: "models_disagreed" },
          ],
          byIndex: new Map(),
          elapsedMs: 1,
        }),
        isPatchAgentClickApplyEnabledForInstall: vi.fn().mockResolvedValue(true),
      });
      await runReviewWorker("rev-1", "webhook", deps);
      // Gate is short-circuited because byIndex.size === 0
      expect(deps.isPatchAgentClickApplyEnabledForInstall).not.toHaveBeenCalled();
      expect(deps.postPatchReviewComment).not.toHaveBeenCalled();
      expect(deps.recordPatchReviewComment).not.toHaveBeenCalled();
      // recordPatchDecisions still runs (v1.5 persistence of skip reasons)
      expect(deps.recordPatchDecisions).toHaveBeenCalledTimes(1);
      // No patch_proposed events because every decision had patch === null
      expect(deps.recordPatchProposedEvent).not.toHaveBeenCalled();
    });

    // Audit M2: drawdown invariant 3 regression guard. setReviewPatchCost
    // is the only $-adjacent write in the patch lane; v1.6 must NOT
    // add a second write or a duplicate call.
    it("calls setReviewPatchCost exactly once in the click-apply path (drawdown invariant 3)", async () => {
      const deps = mkDeps({
        reviewPR: vi.fn().mockResolvedValue(SINGLE_LINE_BUNDLE),
        runPatchAgent: vi.fn().mockResolvedValue(PATCH_OUTCOME),
        isPatchAgentClickApplyEnabledForInstall: vi.fn().mockResolvedValue(true),
        postPatchReviewComment: vi.fn().mockResolvedValue({ id: 1, url: "u" }),
      });
      await runReviewWorker("rev-1", "webhook", deps);
      expect(deps.setReviewPatchCost).toHaveBeenCalledTimes(1);
    });

    // Audit B1: patch_proposed event carries the review_comment_id/url
    // when click-apply post succeeded for that finding.
    it("plumbs review_comment_id/url into recordPatchProposedEvent for clicked findings", async () => {
      const deps = mkDeps({
        reviewPR: vi.fn().mockResolvedValue(SINGLE_LINE_BUNDLE),
        runPatchAgent: vi.fn().mockResolvedValue(PATCH_OUTCOME),
        isPatchAgentClickApplyEnabledForInstall: vi.fn().mockResolvedValue(true),
        postPatchReviewComment: vi
          .fn()
          .mockResolvedValue({ id: 4242, url: "https://gh/pr#r4242" }),
      });
      await runReviewWorker("rev-1", "webhook", deps);
      expect(deps.recordPatchProposedEvent).toHaveBeenCalledTimes(1);
      const evtArg = (deps.recordPatchProposedEvent as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0];
      expect(evtArg.findingId).toBe("rev-1-0");
      expect(evtArg.reviewCommentId).toBe(4242);
      expect(evtArg.reviewCommentUrl).toBe("https://gh/pr#r4242");
    });

    // Complement to B1: when click-apply is off, patch_proposed event
    // carries null IDs (matches v1.5 shape — no regression).
    it("passes null review_comment_id/url to patch_proposed event when click-apply off", async () => {
      const deps = mkDeps({
        reviewPR: vi.fn().mockResolvedValue(SINGLE_LINE_BUNDLE),
        runPatchAgent: vi.fn().mockResolvedValue(PATCH_OUTCOME),
        isPatchAgentClickApplyEnabledForInstall: vi.fn().mockResolvedValue(false),
      });
      await runReviewWorker("rev-1", "webhook", deps);
      const evtArg = (deps.recordPatchProposedEvent as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0];
      expect(evtArg.reviewCommentId).toBeNull();
      expect(evtArg.reviewCommentUrl).toBeNull();
    });
  });
});

describe("computeNextRetryAt", () => {
  it("returns 60s for the first failure", () => {
    const next = computeNextRetryAt(NOW, 1);
    expect(next.getTime() - NOW.getTime()).toBe(60_000);
  });

  it("doubles each step up to the 30-minute cap", () => {
    expect(computeNextRetryAt(NOW, 1).getTime() - NOW.getTime()).toBe(60_000);
    expect(computeNextRetryAt(NOW, 2).getTime() - NOW.getTime()).toBe(120_000);
    expect(computeNextRetryAt(NOW, 3).getTime() - NOW.getTime()).toBe(240_000);
    expect(computeNextRetryAt(NOW, 4).getTime() - NOW.getTime()).toBe(480_000);
    expect(computeNextRetryAt(NOW, 5).getTime() - NOW.getTime()).toBe(960_000);
    expect(computeNextRetryAt(NOW, 6).getTime() - NOW.getTime()).toBe(1_800_000);
    // Out-of-range clamps to the last bucket rather than crashing.
    expect(computeNextRetryAt(NOW, 99).getTime() - NOW.getTime()).toBe(1_800_000);
  });
});

describe("isTransientError", () => {
  it("treats common rate-limit signals as transient", () => {
    expect(isTransientError(new Error("HTTP 429"))).toBe(true);
    expect(isTransientError(new Error("rate limit hit"))).toBe(true);
    expect(isTransientError(new Error("rate_limit_exceeded"))).toBe(true);
  });

  it("treats 5xx upstream failures as transient", () => {
    expect(isTransientError(new Error("HTTP 503 Service Unavailable"))).toBe(true);
    expect(isTransientError(new Error("HTTP 502 bad gateway"))).toBe(true);
  });

  it("treats network failures as transient", () => {
    expect(isTransientError(new Error("ETIMEDOUT"))).toBe(true);
    expect(isTransientError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
  });
});
