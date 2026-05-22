import { describe, expect, it, vi } from "vitest";
import { runSweep, type SweepDeps } from "./sweep";
import type { SweepReviewBatch } from "../db/queries";

// Frozen-in-test "now" so age math is deterministic. Real cron uses Date.now().
const NOW = new Date("2026-05-17T12:00:00Z");

function freshFinding(id: string, index: number, daysOld = 1) {
  return {
    findingId: id,
    findingIndex: index,
    prCommentId: 9001,
    createdAt: new Date(NOW.getTime() - daysOld * 24 * 60 * 60 * 1000),
    lastPolledAt: null,
  };
}

function validFinding(overrides: Record<string, unknown> = {}) {
  return {
    title: "Null pointer in handler",
    category: "bug",
    severity: "high",
    reasoning: "rationale",
    recommendation: "guard the access",
    evidence: [{ path: "src/handler.ts", startLine: 42, endLine: 50 }],
    ...overrides,
  };
}

function productionAgreement(...findings: Array<Record<string, unknown>>) {
  return {
    mode: "unanimous",
    agreed: findings,
    disagreements: [],
    degraded: false,
    degradedReason: null,
  };
}

function mkBatch(overrides: Partial<SweepReviewBatch> = {}): SweepReviewBatch {
  return {
    reviewId: "review-1",
    installationId: 132854945,
    owner: "Augustas11",
    repo: "krisskross_shops",
    prNumber: 1,
    commitSha: "old-sha",
    prCommentId: 9001,
    prCommentUrl: "https://github.com/Augustas11/krisskross_shops/issues/1#issuecomment-9001",
    agreementDecision: productionAgreement(validFinding()),
    findings: [freshFinding("review-1-0", 0)],
    ...overrides,
  };
}

function mkDeps(overrides: Partial<SweepDeps> = {}): SweepDeps {
  return {
    loadSweepWork: vi.fn().mockResolvedValue([]),
    detectClosures: vi.fn().mockResolvedValue([]),
    postPRComment: vi.fn().mockResolvedValue({ id: 7777, htmlUrl: "https://example/c/7777" }),
    markFindingClosed: vi.fn().mockResolvedValue(undefined),
    pollReactions: vi.fn().mockResolvedValue([]),
    recordMaintainerReactions: vi.fn().mockResolvedValue(0),
    stampFindingPolled: vi.fn().mockResolvedValue(undefined),
    // Patch Agent v1.5 — patch-acceptance pass deps. Default: empty
    // candidate set (no patches awaiting acceptance). Tests that exercise
    // the pass override this.
    loadPatchAcceptanceWork: vi.fn().mockResolvedValue([]),
    markPatchAccepted: vi.fn().mockResolvedValue(undefined),
    fetchFileAtRef: vi.fn().mockResolvedValue(null),
    recordPatchAcceptedEvent: vi.fn().mockResolvedValue(undefined),
    // Patch Agent v1.6 — click-apply detection pass deps. Default: empty.
    loadPatchReviewCommentAcceptanceWork: vi.fn().mockResolvedValue([]),
    markPatchApplyClicked: vi.fn().mockResolvedValue(undefined),
    recordPatchApplyClickedEvent: vi.fn().mockResolvedValue(undefined),
    fetchReviewComment: vi.fn().mockResolvedValue(null),
    getDefaultBranchSha: vi.fn().mockResolvedValue(null),
    now: () => NOW,
    ...overrides,
  };
}

describe("runSweep", () => {
  it("returns zero counters and no errors when there is no work", async () => {
    const deps = mkDeps();
    const out = await runSweep(deps);
    expect(out).toEqual({
      swept: 0,
      closed: 0,
      patchesAccepted: 0,
      patchApplyClicks: 0,
      reactionsRecorded: 0,
      reviewsSkipped: 0,
      errors: [],
    });
    expect(deps.detectClosures).not.toHaveBeenCalled();
    expect(deps.pollReactions).not.toHaveBeenCalled();
  });

  it("skips a review whose agreement_decision is the pending stub shape", async () => {
    const batch = mkBatch({ agreementDecision: { status: "pending" } });
    const deps = mkDeps({ loadSweepWork: vi.fn().mockResolvedValue([batch]) });
    const out = await runSweep(deps);
    expect(out.reviewsSkipped).toBe(1);
    expect(out.swept).toBe(0);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatchObject({
      scope: "batch",
      reviewId: "review-1",
      message: expect.stringContaining("malformed"),
    });
    expect(deps.detectClosures).not.toHaveBeenCalled();
  });

  it("closes a finding when detectClosures returns closed, posting receipt and marking", async () => {
    const batch = mkBatch();
    const deps = mkDeps({
      loadSweepWork: vi.fn().mockResolvedValue([batch]),
      detectClosures: vi
        .fn()
        .mockResolvedValue([{ findingId: "review-1-0", status: "closed", closureSha: "new-sha" }]),
    });
    const out = await runSweep(deps);
    expect(out.closed).toBe(1);
    expect(out.swept).toBe(1);
    expect(deps.postPRComment).toHaveBeenCalledTimes(1);
    expect(deps.postPRComment).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: 132854945,
        owner: "Augustas11",
        repo: "krisskross_shops",
        prNumber: 1,
        body: expect.stringContaining("review-1-0"),
      }),
    );
    expect(deps.markFindingClosed).toHaveBeenCalledWith({
      findingId: "review-1-0",
      closureSha: "new-sha",
      closureCommentId: 7777,
      closureCommentUrl: "https://example/c/7777",
    });
  });

  it("does not poll reactions on a finding that was just closed", async () => {
    const batch = mkBatch();
    const deps = mkDeps({
      loadSweepWork: vi.fn().mockResolvedValue([batch]),
      detectClosures: vi
        .fn()
        .mockResolvedValue([{ findingId: "review-1-0", status: "closed", closureSha: "new-sha" }]),
    });
    await runSweep(deps);
    expect(deps.pollReactions).not.toHaveBeenCalled();
    expect(deps.stampFindingPolled).not.toHaveBeenCalled();
  });

  it("polls reactions and records the insert count from recordMaintainerReactions", async () => {
    const batch = mkBatch();
    const rawReactions = [
      { content: "+1" as const, created_at: "2026-05-17T09:00:00Z" },
      { content: "rocket" as const, created_at: "2026-05-17T10:00:00Z" },
    ];
    const deps = mkDeps({
      loadSweepWork: vi.fn().mockResolvedValue([batch]),
      detectClosures: vi
        .fn()
        .mockResolvedValue([{ findingId: "review-1-0", status: "still_open" }]),
      pollReactions: vi.fn().mockResolvedValue(rawReactions),
      recordMaintainerReactions: vi.fn().mockResolvedValue(2),
    });
    const out = await runSweep(deps);
    expect(out.reactionsRecorded).toBe(2);
    expect(deps.pollReactions).toHaveBeenCalledWith({
      installationId: 132854945,
      owner: "Augustas11",
      repo: "krisskross_shops",
      commentId: 9001,
    });
    expect(deps.stampFindingPolled).toHaveBeenCalledWith("review-1-0", NOW);
  });

  it("skips the reaction pass when the review has no posted comment", async () => {
    const batch = mkBatch({
      prCommentId: null,
      findings: [{ ...freshFinding("review-1-0", 0), prCommentId: null }],
    });
    const deps = mkDeps({ loadSweepWork: vi.fn().mockResolvedValue([batch]) });
    await runSweep(deps);
    expect(deps.pollReactions).not.toHaveBeenCalled();
  });

  it("skips findings older than the 30-day reaction horizon", async () => {
    const batch = mkBatch({
      findings: [freshFinding("review-1-0", 0, 31)],
    });
    const deps = mkDeps({ loadSweepWork: vi.fn().mockResolvedValue([batch]) });
    await runSweep(deps);
    expect(deps.pollReactions).not.toHaveBeenCalled();
  });

  it("includes findings exactly at the 30-day horizon (boundary inclusive)", async () => {
    const batch = mkBatch({
      findings: [freshFinding("review-1-0", 0, 30)],
    });
    const deps = mkDeps({ loadSweepWork: vi.fn().mockResolvedValue([batch]) });
    await runSweep(deps);
    expect(deps.pollReactions).toHaveBeenCalledTimes(1);
  });

  it("contains a postPRComment error to one finding without aborting the batch", async () => {
    const batch = mkBatch({
      agreementDecision: productionAgreement(validFinding(), validFinding({ title: "second" })),
      findings: [freshFinding("review-1-0", 0), freshFinding("review-1-1", 1)],
    });
    const deps = mkDeps({
      loadSweepWork: vi.fn().mockResolvedValue([batch]),
      detectClosures: vi.fn().mockResolvedValue([
        { findingId: "review-1-0", status: "closed", closureSha: "new-sha" },
        { findingId: "review-1-1", status: "closed", closureSha: "new-sha" },
      ]),
      postPRComment: vi
        .fn()
        .mockRejectedValueOnce(new Error("403 forbidden"))
        .mockResolvedValueOnce({ id: 8888, htmlUrl: "https://example/c/8888" }),
    });
    const out = await runSweep(deps);
    expect(out.closed).toBe(1);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatchObject({
      scope: "closure",
      reviewId: "review-1",
      findingId: "review-1-0",
      message: expect.stringContaining("403 forbidden"),
    });
    // markFindingClosed only ran for the success.
    expect(deps.markFindingClosed).toHaveBeenCalledTimes(1);
    expect(deps.markFindingClosed).toHaveBeenCalledWith(
      expect.objectContaining({ findingId: "review-1-1" }),
    );
  });

  it("captures a detectClosures failure as a closure-pass batch error and still runs the reaction pass", async () => {
    const batch = mkBatch();
    const deps = mkDeps({
      loadSweepWork: vi.fn().mockResolvedValue([batch]),
      detectClosures: vi.fn().mockRejectedValue(new Error("compareCommits 500")),
      pollReactions: vi
        .fn()
        .mockResolvedValue([{ content: "+1" as const, created_at: "2026-05-17T09:00:00Z" }]),
      recordMaintainerReactions: vi.fn().mockResolvedValue(1),
    });
    const out = await runSweep(deps);
    expect(out.closed).toBe(0);
    expect(out.reactionsRecorded).toBe(1);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatchObject({
      scope: "batch",
      message: expect.stringContaining("closure pass"),
    });
  });

  it("captures a recordMaintainerReactions failure per finding without aborting later findings", async () => {
    const batch = mkBatch({
      agreementDecision: productionAgreement(validFinding(), validFinding({ title: "second" })),
      findings: [freshFinding("review-1-0", 0), freshFinding("review-1-1", 1)],
    });
    const deps = mkDeps({
      loadSweepWork: vi.fn().mockResolvedValue([batch]),
      detectClosures: vi.fn().mockResolvedValue([
        { findingId: "review-1-0", status: "still_open" },
        { findingId: "review-1-1", status: "still_open" },
      ]),
      pollReactions: vi
        .fn()
        .mockResolvedValue([{ content: "+1" as const, created_at: "2026-05-17T09:00:00Z" }]),
      recordMaintainerReactions: vi
        .fn()
        .mockRejectedValueOnce(new Error("unique constraint missing"))
        .mockResolvedValueOnce(1),
    });
    const out = await runSweep(deps);
    expect(out.reactionsRecorded).toBe(1);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatchObject({
      scope: "reaction",
      findingId: "review-1-0",
      message: expect.stringContaining("unique constraint"),
    });
    expect(deps.stampFindingPolled).toHaveBeenCalledTimes(1);
    expect(deps.stampFindingPolled).toHaveBeenCalledWith("review-1-1", NOW);
  });

  it("groups findings per batch and only one pollReactions call per review", async () => {
    // Two findings on the same review share one comment — assert one fetch.
    const batch = mkBatch({
      agreementDecision: productionAgreement(validFinding(), validFinding({ title: "second" })),
      findings: [freshFinding("review-1-0", 0), freshFinding("review-1-1", 1)],
    });
    const deps = mkDeps({
      loadSweepWork: vi.fn().mockResolvedValue([batch]),
      detectClosures: vi.fn().mockResolvedValue([
        { findingId: "review-1-0", status: "still_open" },
        { findingId: "review-1-1", status: "still_open" },
      ]),
    });
    await runSweep(deps);
    expect(deps.pollReactions).toHaveBeenCalledTimes(1);
  });

  // Patch Agent v1.5 — patch-acceptance pass tests. Co-exist with the
  // closure pass: both can fire on the same tick without interfering.
  describe("patch-acceptance pass", () => {
    const candidate = {
      findingId: "review-1-0",
      reviewId: "review-1",
      installationId: 132854945,
      owner: "owner",
      repo: "repo",
      prNumber: 1,
      prCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-9001",
      suggestedPatch: "@@ -1,1 +1,1 @@\n-const x = 1;\n+const x = 0;\n",
      patchModelId: "claude-opus-4-7",
      evidencePath: "src/foo.ts",
    };

    it("marks accepted + posts a receipt when the suggestion is present in HEAD", async () => {
      const deps = mkDeps({
        loadPatchAcceptanceWork: vi.fn().mockResolvedValue([candidate]),
        getDefaultBranchSha: vi.fn().mockResolvedValue("abc123"),
        fetchFileAtRef: vi.fn().mockResolvedValue("const x = 0;\nreturn x;\n"),
      });
      const result = await runSweep(deps);
      expect(result.patchesAccepted).toBe(1);
      expect(deps.markPatchAccepted).toHaveBeenCalledWith({
        findingId: "review-1-0",
        acceptedSha: "abc123",
        now: expect.any(Date),
      });
      expect(deps.postPRComment).toHaveBeenCalledTimes(1);
      const postedBody = (deps.postPRComment as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].body;
      expect(postedBody).toContain("suggested patch for `review-1-0` accepted in");
      expect(postedBody).toContain("`claude-opus-4-7`");
    });

    it("does nothing when the suggestion is NOT present in HEAD", async () => {
      const deps = mkDeps({
        loadPatchAcceptanceWork: vi.fn().mockResolvedValue([candidate]),
        getDefaultBranchSha: vi.fn().mockResolvedValue("abc123"),
        // File has different content than the suggestion proposed.
        fetchFileAtRef: vi.fn().mockResolvedValue("const x = 42;\n"),
      });
      const result = await runSweep(deps);
      expect(result.patchesAccepted).toBe(0);
      expect(deps.markPatchAccepted).not.toHaveBeenCalled();
      expect(deps.postPRComment).not.toHaveBeenCalled();
    });

    it("skips when default-branch SHA cannot be resolved", async () => {
      const deps = mkDeps({
        loadPatchAcceptanceWork: vi.fn().mockResolvedValue([candidate]),
        getDefaultBranchSha: vi.fn().mockResolvedValue(null),
      });
      const result = await runSweep(deps);
      expect(result.patchesAccepted).toBe(0);
      expect(deps.fetchFileAtRef).not.toHaveBeenCalled();
      // No error scoped — silent retry next tick.
      expect(result.errors).toEqual([]);
    });

    it("caches the default-branch SHA across multiple candidates in the same repo", async () => {
      const second = {
        ...candidate,
        findingId: "review-1-1",
        suggestedPatch: "@@ -1,1 +1,1 @@\n-const y = 1;\n+const y = 0;\n",
      };
      const getSha = vi.fn().mockResolvedValue("abc123");
      const deps = mkDeps({
        loadPatchAcceptanceWork: vi.fn().mockResolvedValue([candidate, second]),
        getDefaultBranchSha: getSha,
        fetchFileAtRef: vi.fn().mockResolvedValue("nothing matches\n"),
      });
      await runSweep(deps);
      // Single resolution despite two candidates on the same repo.
      expect(getSha).toHaveBeenCalledTimes(1);
    });

    it("scopes per-candidate errors without halting the pass", async () => {
      const second = { ...candidate, findingId: "review-1-1", reviewId: "review-2" };
      const deps = mkDeps({
        loadPatchAcceptanceWork: vi.fn().mockResolvedValue([candidate, second]),
        getDefaultBranchSha: vi.fn().mockResolvedValue("abc123"),
        fetchFileAtRef: vi
          .fn()
          .mockImplementationOnce(() => {
            throw new Error("octokit 500");
          })
          .mockResolvedValueOnce("const x = 0;\n"),
      });
      const result = await runSweep(deps);
      // Second candidate still detected; first errored but was scoped.
      expect(result.patchesAccepted).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.scope).toBe("patch_acceptance");
      expect(result.errors[0]?.findingId).toBe("review-1-0");
    });

    it("does not interfere with the closure pass (both can fire on the same tick)", async () => {
      const deps = mkDeps({
        loadSweepWork: vi.fn().mockResolvedValue([mkBatch()]),
        detectClosures: vi
          .fn()
          .mockResolvedValue([
            { findingId: "review-1-0", status: "closed", closureSha: "closuresha" },
          ]),
        loadPatchAcceptanceWork: vi.fn().mockResolvedValue([candidate]),
        getDefaultBranchSha: vi.fn().mockResolvedValue("abc123"),
        fetchFileAtRef: vi.fn().mockResolvedValue("const x = 0;\n"),
      });
      const result = await runSweep(deps);
      expect(result.closed).toBe(1);
      expect(result.patchesAccepted).toBe(1);
      // Two receipt comments — one closure, one patch-acceptance.
      expect(deps.postPRComment).toHaveBeenCalledTimes(2);
    });

    it("records an error and skips when candidate has no evidence path", async () => {
      const deps = mkDeps({
        loadPatchAcceptanceWork: vi.fn().mockResolvedValue([{ ...candidate, evidencePath: null }]),
      });
      const result = await runSweep(deps);
      expect(result.patchesAccepted).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.scope).toBe("patch_acceptance");
    });

    // PR7 wiring — onboarder event fires when sweeper marks accepted.
    it("fires recordPatchAcceptedEvent after the comment posts", async () => {
      const deps = mkDeps({
        loadPatchAcceptanceWork: vi.fn().mockResolvedValue([candidate]),
        getDefaultBranchSha: vi.fn().mockResolvedValue("abc123"),
        fetchFileAtRef: vi.fn().mockResolvedValue("const x = 0;\n"),
      });
      await runSweep(deps);
      expect(deps.recordPatchAcceptedEvent).toHaveBeenCalledTimes(1);
      const args = (deps.recordPatchAcceptedEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(args?.findingId).toBe("review-1-0");
      expect(args?.acceptedSha).toBe("abc123");
      expect(args?.modelId).toBe("claude-opus-4-7");
      // The comment id from postPRComment is plumbed through.
      expect(args?.acceptanceCommentId).toBe(7777);
    });
  });

  describe("Patch Agent v1.6 — click-apply detection pass", () => {
    const APPLIED_PATCH = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -10,1 +10,1 @@",
      "-const x = 1;",
      "+const x = 2;",
      "",
    ].join("\n");

    function mkClickCandidate(overrides: Record<string, unknown> = {}) {
      return {
        findingId: "review-1-0",
        reviewId: "review-1",
        installationId: 132854945,
        owner: "Augustas11",
        repo: "krisskross_shops",
        prNumber: 1,
        prCommentUrl: "https://github.com/Augustas11/krisskross_shops/issues/1#issuecomment-9001",
        suggestedPatch: APPLIED_PATCH,
        patchModelId: "claude-opus-4-7",
        evidencePath: "src/foo.ts",
        // Anchor at line 1 so the test fixture's file_at_ref content
        // ("const x = 2;\n") matches starting at line 1 — patch's new
        // side is exactly that one line.
        evidenceStartLine: 1,
        reviewCommentId: 7777,
        reviewCommentUrl: "https://github.com/Augustas11/krisskross_shops/pull/1#r7777",
        ...overrides,
      };
    }

    it("no-op when there are no candidates", async () => {
      const deps = mkDeps();
      const out = await runSweep(deps);
      expect(out.patchApplyClicks).toBe(0);
      expect(deps.fetchReviewComment).not.toHaveBeenCalled();
      expect(deps.markPatchApplyClicked).not.toHaveBeenCalled();
    });

    it("no-op when commit_id equals original_commit_id (no advance)", async () => {
      const deps = mkDeps({
        loadPatchReviewCommentAcceptanceWork: vi.fn().mockResolvedValue([mkClickCandidate()]),
        fetchReviewComment: vi.fn().mockResolvedValue({ commitId: "abc", originalCommitId: "abc" }),
      });
      const out = await runSweep(deps);
      expect(out.patchApplyClicks).toBe(0);
      expect(deps.fetchFileAtRef).not.toHaveBeenCalled();
      expect(deps.markPatchApplyClicked).not.toHaveBeenCalled();
    });

    it("detects apply when commit_id advanced AND new commit content matches", async () => {
      const deps = mkDeps({
        loadPatchReviewCommentAcceptanceWork: vi.fn().mockResolvedValue([mkClickCandidate()]),
        fetchReviewComment: vi
          .fn()
          .mockResolvedValue({ commitId: "newsha", originalCommitId: "oldsha" }),
        fetchFileAtRef: vi.fn().mockResolvedValue("const x = 2;\n"),
      });
      const out = await runSweep(deps);
      expect(out.patchApplyClicks).toBe(1);
      expect(out.errors).toEqual([]);
      // Receipt comment posted on the PR
      expect(deps.postPRComment).toHaveBeenCalledTimes(1);
      const postArgs = (deps.postPRComment as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(postArgs.installationId).toBe(132854945);
      expect(postArgs.prNumber).toBe(1);
      expect(postArgs.body).toContain("accepted in");
      expect(postArgs.body).toContain("newsha".slice(0, 7));
      // Row marked
      expect(deps.markPatchApplyClicked).toHaveBeenCalledWith({
        findingId: "review-1-0",
        now: NOW,
      });
      // Event fired (fire-and-forget; assertion is on the call having happened)
      expect(deps.recordPatchApplyClickedEvent).toHaveBeenCalledTimes(1);
      const evtArgs = (deps.recordPatchApplyClickedEvent as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0];
      expect(evtArgs.findingId).toBe("review-1-0");
      expect(evtArgs.appliedSha).toBe("newsha");
      expect(evtArgs.reviewCommentId).toBe(7777);
    });

    it("no apply when commit_id advanced but anchor content does NOT match (push, not apply)", async () => {
      const deps = mkDeps({
        loadPatchReviewCommentAcceptanceWork: vi.fn().mockResolvedValue([mkClickCandidate()]),
        fetchReviewComment: vi
          .fn()
          .mockResolvedValue({ commitId: "newsha", originalCommitId: "oldsha" }),
        // File at newsha contains something else — maintainer pushed an
        // unrelated commit, not the click-apply.
        fetchFileAtRef: vi.fn().mockResolvedValue("const x = 99;\n"),
      });
      const out = await runSweep(deps);
      expect(out.patchApplyClicks).toBe(0);
      expect(deps.markPatchApplyClicked).not.toHaveBeenCalled();
      expect(deps.recordPatchApplyClickedEvent).not.toHaveBeenCalled();
    });

    it("rejects false-positive: matching content present elsewhere in file but NOT at anchor line", async () => {
      // Audit H2 regression — v1.5's whole-file scan would have triggered
      // a false attribution here. v1.6's anchor-bound match must NOT.
      // Anchor is line 1; matching content "const x = 2;" exists at line 5.
      const deps = mkDeps({
        loadPatchReviewCommentAcceptanceWork: vi.fn().mockResolvedValue([mkClickCandidate()]),
        fetchReviewComment: vi
          .fn()
          .mockResolvedValue({ commitId: "newsha", originalCommitId: "oldsha" }),
        fetchFileAtRef: vi
          .fn()
          .mockResolvedValue(
            [
              "import x from 'lib';",
              "",
              "// unrelated edit by maintainer",
              "function f() {",
              "  const x = 2;",
              "}",
              "",
            ].join("\n"),
          ),
      });
      const out = await runSweep(deps);
      expect(out.patchApplyClicks).toBe(0);
      expect(deps.markPatchApplyClicked).not.toHaveBeenCalled();
    });

    it("error-scopes a candidate with null evidenceStartLine; processes the rest", async () => {
      const ok = mkClickCandidate({ findingId: "review-1-1", reviewCommentId: 8888 });
      const noLine = mkClickCandidate({ findingId: "review-1-0", evidenceStartLine: null });
      const deps = mkDeps({
        loadPatchReviewCommentAcceptanceWork: vi.fn().mockResolvedValue([noLine, ok]),
        fetchReviewComment: vi
          .fn()
          .mockResolvedValue({ commitId: "newsha", originalCommitId: "oldsha" }),
        fetchFileAtRef: vi.fn().mockResolvedValue("const x = 2;\n"),
      });
      const out = await runSweep(deps);
      expect(out.patchApplyClicks).toBe(1);
      expect(out.errors).toHaveLength(1);
      expect(out.errors[0]).toMatchObject({
        scope: "patch_apply_clicked",
        findingId: "review-1-0",
        message: expect.stringContaining("startLine"),
      });
      expect(deps.markPatchApplyClicked).toHaveBeenCalledTimes(1);
      expect(deps.markPatchApplyClicked).toHaveBeenCalledWith({
        findingId: "review-1-1",
        now: NOW,
      });
    });

    it("silently skips when fetchReviewComment returns null (comment deleted)", async () => {
      const deps = mkDeps({
        loadPatchReviewCommentAcceptanceWork: vi.fn().mockResolvedValue([mkClickCandidate()]),
        fetchReviewComment: vi.fn().mockResolvedValue(null),
      });
      const out = await runSweep(deps);
      expect(out.patchApplyClicks).toBe(0);
      expect(out.errors).toEqual([]);
      expect(deps.fetchFileAtRef).not.toHaveBeenCalled();
    });

    it("error-scopes a candidate with null evidencePath; processes the rest", async () => {
      const ok = mkClickCandidate({ findingId: "review-1-1", reviewCommentId: 8888 });
      const bad = mkClickCandidate({ findingId: "review-1-0", evidencePath: null });
      const deps = mkDeps({
        loadPatchReviewCommentAcceptanceWork: vi.fn().mockResolvedValue([bad, ok]),
        fetchReviewComment: vi
          .fn()
          .mockResolvedValue({ commitId: "newsha", originalCommitId: "oldsha" }),
        fetchFileAtRef: vi.fn().mockResolvedValue("const x = 2;\n"),
      });
      const out = await runSweep(deps);
      expect(out.patchApplyClicks).toBe(1);
      expect(out.errors).toHaveLength(1);
      expect(out.errors[0]).toMatchObject({
        scope: "patch_apply_clicked",
        findingId: "review-1-0",
        message: expect.stringContaining("no evidence path"),
      });
      expect(deps.markPatchApplyClicked).toHaveBeenCalledTimes(1);
      expect(deps.markPatchApplyClicked).toHaveBeenCalledWith({
        findingId: "review-1-1",
        now: NOW,
      });
    });

    it("scopes a per-candidate fetch error without halting the pass", async () => {
      const ok = mkClickCandidate({ findingId: "review-1-1", reviewCommentId: 8888 });
      const fetchReviewComment = vi
        .fn()
        .mockResolvedValueOnce(null) // first call: returns null — silently skipped (no error scoped)
        .mockRejectedValueOnce(new Error("rate_limit_exceeded")); // second call: throws
      const deps = mkDeps({
        loadPatchReviewCommentAcceptanceWork: vi.fn().mockResolvedValue([mkClickCandidate(), ok]),
        fetchReviewComment,
      });
      const out = await runSweep(deps);
      expect(out.patchApplyClicks).toBe(0);
      // One error scoped to the rejected candidate
      expect(out.errors).toHaveLength(1);
      expect(out.errors[0]).toMatchObject({
        scope: "patch_apply_clicked",
        findingId: "review-1-1",
        message: expect.stringContaining("rate_limit"),
      });
    });
  });
});
