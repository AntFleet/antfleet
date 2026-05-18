import { describe, expect, it, vi } from "vitest";
import {
  pollOutgoingPrs,
  upstreamPrUrl,
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
    ...overrides,
  };
}

function makeDeps(overrides: Partial<PollOutgoingDeps> = {}): PollOutgoingDeps {
  return {
    loadOpenPrs: vi.fn().mockResolvedValue([]),
    getUpstreamPrState: vi.fn(),
    markMerged: vi.fn().mockResolvedValue(undefined),
    markClosed: vi.fn().mockResolvedValue(undefined),
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

  it("transitions closed-without-merge to status=closed", async () => {
    const pr = makePr();
    const markClosed = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadOpenPrs: vi.fn().mockResolvedValue([pr]),
      getUpstreamPrState: vi.fn().mockResolvedValue(CLOSED_NO_MERGE_STATE),
      markClosed,
    });
    const result = await pollOutgoingPrs(deps, NOW);
    expect(result.closed).toBe(1);
    expect(markClosed).toHaveBeenCalledWith({ id: pr.id, polledAt: NOW });
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

  it("does not flip when GitHub reports merged but merge_sha is missing", async () => {
    // Defensive: a Drizzle-side NOT NULL on merge_sha would crash if we
    // accepted this state. The poll loop demands both pieces of evidence
    // before claiming a merge.
    const pr = makePr();
    const incomplete: UpstreamPrState = {
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
      getUpstreamPrState: vi.fn().mockResolvedValue(incomplete),
      stampPolled,
      markMerged,
      markClosed,
    });
    const result = await pollOutgoingPrs(deps, NOW);
    // state==closed without merge_sha — falls through to closed branch
    // (no merge evidence to assert).
    expect(markMerged).not.toHaveBeenCalled();
    expect(markClosed).toHaveBeenCalledTimes(1);
    expect(result.closed).toBe(1);
  });
});

describe("upstreamPrUrl", () => {
  it("renders https://github.com/owner/repo/pull/n", () => {
    expect(upstreamPrUrl("Liquid-Protocol-Ops", "agent-autonomopoly", 3)).toBe(
      "https://github.com/Liquid-Protocol-Ops/agent-autonomopoly/pull/3",
    );
  });
});
