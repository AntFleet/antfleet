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
      detectClosures: vi.fn().mockResolvedValue([
        { findingId: "review-1-0", status: "closed", closureSha: "new-sha" },
      ]),
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
      detectClosures: vi.fn().mockResolvedValue([
        { findingId: "review-1-0", status: "closed", closureSha: "new-sha" },
      ]),
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
      detectClosures: vi.fn().mockResolvedValue([
        { findingId: "review-1-0", status: "still_open" },
      ]),
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
      pollReactions: vi.fn().mockResolvedValue([
        { content: "+1" as const, created_at: "2026-05-17T09:00:00Z" },
      ]),
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
      pollReactions: vi.fn().mockResolvedValue([
        { content: "+1" as const, created_at: "2026-05-17T09:00:00Z" },
      ]),
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
});
