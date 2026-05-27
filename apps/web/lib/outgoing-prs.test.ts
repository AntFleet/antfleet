import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  pollOutgoingPrs,
  runOutgoingPrsPoll,
  type OpenOutgoingPr,
  type PollOutgoingDeps,
  type UpstreamPrState,
} from "./outgoing-prs";

const NOW = new Date("2026-05-18T10:00:00.000Z");

function makePr(overrides: Partial<OpenOutgoingPr> = {}): OpenOutgoingPr {
  return {
    id: "pr-id-1",
    upstreamOwner: "Liquid-Protocol-Ops",
    upstreamRepo: "agent-autonomopoly",
    upstreamPrNumber: 3,
    openedAt: new Date("2026-05-18T05:00:00.000Z"),
    branchOnFork: "antfleet/agent-autonomopoly-bench:fix/threshold-harmonization",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<PollOutgoingDeps> = {}): PollOutgoingDeps {
  return {
    loadOpenPrs: vi.fn().mockResolvedValue([]),
    getUpstreamPrState: vi.fn(),
    markMerged: vi.fn().mockResolvedValue(undefined),
    markClosed: vi.fn().mockResolvedValue(undefined),
    markAbsorbed: vi.fn().mockResolvedValue(undefined),
    detectAbsorbed: vi.fn().mockResolvedValue({ absorbed: false }),
    stampPolled: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const OPEN_STATE: UpstreamPrState = {
  merged: false,
  mergedAt: null,
  mergeSha: null,
  state: "open",
};

const MERGED_STATE: UpstreamPrState = {
  merged: true,
  mergedAt: new Date("2026-05-17T12:00:00.000Z"),
  mergeSha: "a".repeat(40),
  state: "closed",
};

const CLOSED_NO_MERGE_STATE: UpstreamPrState = {
  merged: false,
  mergedAt: null,
  mergeSha: null,
  state: "closed",
};

describe("pollOutgoingPrs", () => {
  it("returns zero counts when there are no open PRs", async () => {
    const deps = makeDeps({ loadOpenPrs: vi.fn().mockResolvedValue([]) });
    const result = await pollOutgoingPrs(deps, NOW);
    expect(result).toEqual({
      attempted: 0,
      merged: 0,
      closed: 0,
      absorbed: 0,
      unchanged: 0,
      errors: 0,
    });
    expect(deps.getUpstreamPrState).not.toHaveBeenCalled();
  });

  it("stamps polled_at on PRs still open upstream — no status flip", async () => {
    const pr = makePr();
    const stampPolled = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadOpenPrs: vi.fn().mockResolvedValue([pr]),
      getUpstreamPrState: vi.fn().mockResolvedValue(OPEN_STATE),
      stampPolled,
    });
    const result = await pollOutgoingPrs(deps, NOW);
    expect(result.unchanged).toBe(1);
    expect(result.merged).toBe(0);
    expect(result.closed).toBe(0);
    expect(stampPolled).toHaveBeenCalledWith({ id: pr.id, polledAt: NOW });
  });

  it("transitions merged PRs and persists merge_sha + merged_at", async () => {
    const pr = makePr();
    const markMerged = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadOpenPrs: vi.fn().mockResolvedValue([pr]),
      getUpstreamPrState: vi.fn().mockResolvedValue(MERGED_STATE),
      markMerged,
    });
    const result = await pollOutgoingPrs(deps, NOW);
    expect(result.merged).toBe(1);
    expect(markMerged).toHaveBeenCalledWith({
      id: pr.id,
      mergedAt: MERGED_STATE.mergedAt,
      mergeSha: MERGED_STATE.mergeSha,
      polledAt: NOW,
    });
  });

  it("transitions closed-without-merge to status=closed when detection returns absorbed=false", async () => {
    const pr = makePr();
    const markClosed = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadOpenPrs: vi.fn().mockResolvedValue([pr]),
      getUpstreamPrState: vi.fn().mockResolvedValue(CLOSED_NO_MERGE_STATE),
      markClosed,
    });
    const result = await pollOutgoingPrs(deps, NOW);
    expect(result.closed).toBe(1);
    expect(result.absorbed).toBe(0);
    expect(markClosed).toHaveBeenCalledWith({ id: pr.id, polledAt: NOW });
  });

  it("transitions closed-without-merge to closed_absorbed when detection returns absorbed=true", async () => {
    const pr = makePr();
    const markAbsorbed = vi.fn().mockResolvedValue(undefined);
    const markClosed = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadOpenPrs: vi.fn().mockResolvedValue([pr]),
      getUpstreamPrState: vi.fn().mockResolvedValue(CLOSED_NO_MERGE_STATE),
      markAbsorbed,
      markClosed,
      detectAbsorbed: vi.fn().mockResolvedValue({
        absorbed: true,
        commitSha: "abc1234567890",
        confidence: 0.92,
        reasoning: "Same fix applied",
        commitMessage: "fix: apply the same change",
      }),
    });
    const result = await pollOutgoingPrs(deps, NOW);
    expect(result.absorbed).toBe(1);
    expect(result.closed).toBe(0);
    expect(markAbsorbed).toHaveBeenCalledWith({
      id: pr.id,
      closureSha: "abc1234567890",
      closureConfidence: 0.92,
      closureNotes: "Same fix applied",
      polledAt: NOW,
    });
    expect(markClosed).not.toHaveBeenCalled();
  });

  it("counts as error when detectAbsorbed throws — loop continues", async () => {
    const ok = makePr({ id: "ok" });
    const bad = makePr({ id: "bad", upstreamPrNumber: 99 });
    const state = vi
      .fn()
      .mockResolvedValueOnce(CLOSED_NO_MERGE_STATE)
      .mockResolvedValueOnce(MERGED_STATE);
    const markMerged = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadOpenPrs: vi.fn().mockResolvedValue([bad, ok]),
      getUpstreamPrState: state,
      markMerged,
      detectAbsorbed: vi.fn().mockRejectedValue(new Error("LLM timeout")),
    });
    const result = await pollOutgoingPrs(deps, NOW);
    expect(result.errors).toBe(1);
    expect(result.merged).toBe(1);
    expect(markMerged).toHaveBeenCalledTimes(1);
  });

  it("isolates failures per row — one error does not abort the loop", async () => {
    const ok = makePr({ id: "ok" });
    const bad = makePr({ id: "bad", upstreamPrNumber: 4 });
    const state = vi
      .fn()
      .mockResolvedValueOnce(MERGED_STATE)
      .mockRejectedValueOnce(new Error("github 500"));
    const markMerged = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadOpenPrs: vi.fn().mockResolvedValue([ok, bad]),
      getUpstreamPrState: state,
      markMerged,
    });
    const result = await pollOutgoingPrs(deps, NOW);
    expect(result.attempted).toBe(2);
    expect(result.merged).toBe(1);
    expect(result.errors).toBe(1);
    expect(markMerged).toHaveBeenCalledTimes(1);
  });

  it("treats merged=true with null merge_sha as still-in-progress (re-poll next tick)", async () => {
    // GitHub's merge_commit_sha can lag the `merged` flag by seconds-to-
    // minutes while commit propagation completes. Marking such a row
    // declined would lose a real upstream receipt; marking it merged
    // would crash the row's NOT NULL merge_sha invariant. The right
    // move is to stamp polled_at and wait for the next tick to retry.
    const pr = makePr();
    const lagging: UpstreamPrState = {
      merged: true,
      mergedAt: new Date("2026-05-17T12:00:00.000Z"),
      mergeSha: null,
      state: "closed",
    };
    const stampPolled = vi.fn().mockResolvedValue(undefined);
    const markMerged = vi.fn().mockResolvedValue(undefined);
    const markClosed = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadOpenPrs: vi.fn().mockResolvedValue([pr]),
      getUpstreamPrState: vi.fn().mockResolvedValue(lagging),
      stampPolled,
      markMerged,
      markClosed,
    });
    const result = await pollOutgoingPrs(deps, NOW);
    expect(markMerged).not.toHaveBeenCalled();
    expect(markClosed).not.toHaveBeenCalled();
    expect(stampPolled).toHaveBeenCalledWith({ id: pr.id, polledAt: NOW });
    expect(result.unchanged).toBe(1);
    expect(result.merged).toBe(0);
    expect(result.closed).toBe(0);
  });
});

describe("runOutgoingPrsPoll (cron-safe wrapper)", () => {
  beforeEach(() => {
    delete process.env["ANTFLEET_OPS_GH_TOKEN"];
  });

  it("never throws — returns null when the underlying poll fails (db unreachable, token missing, etc.)", async () => {
    // Cron-tick safety contract: any failure inside the poll path must
    // degrade silently. The cron route depends on this — if
    // runOutgoingPrsPoll ever threw, a misconfigured env or a flaky
    // upstream would 5xx the whole sweep tick.
    const result = await runOutgoingPrsPoll();
    expect(result).toBeNull();
  });
});
