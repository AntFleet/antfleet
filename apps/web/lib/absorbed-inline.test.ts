import { describe, expect, it, vi } from "vitest";
import {
  detectAbsorbedInline,
  extractDiffFilePaths,
  type AbsorbedInlineDeps,
} from "./absorbed-inline";

const PR_BASE = {
  upstreamOwner: "Liquid-Protocol-Ops",
  upstreamRepo: "agent-autonomopoly",
  upstreamPrNumber: 5,
  openedAt: new Date("2026-05-18T05:00:00.000Z"),
  branchOnFork: "antfleet/agent-autonomopoly-bench:fix/feelocker-correct-selector",
};

const PR_DIFF = `--- a/skills/on-chain-monitor/SKILL.md
+++ b/skills/on-chain-monitor/SKILL.md
@@ -10,0 +11,5 @@
+4b. View-function reads
+   Pin canonical view-call pattern for check: watches
`;

const MATCHING_COMMIT_DIFF = `--- a/skills/on-chain-monitor/SKILL.md
+++ b/skills/on-chain-monitor/SKILL.md
@@ -10,0 +11,5 @@
+4b. View-function reads
+   Pin canonical view-call pattern for check: watches
+Additional schema check work
`;

function makeDeps(overrides: Partial<AbsorbedInlineDeps> = {}): AbsorbedInlineDeps {
  return {
    getPrDiff: vi.fn().mockResolvedValue(PR_DIFF),
    listRecentCommits: vi.fn().mockResolvedValue([]),
    getCommitDiff: vi.fn().mockResolvedValue(""),
    getCommitFiles: vi.fn().mockResolvedValue([]),
    judgeEquivalence: vi.fn().mockResolvedValue({
      equivalent: false,
      confidence: 0.1,
      reasoning: "Not the same fix",
    }),
    ...overrides,
  };
}

describe("extractDiffFilePaths", () => {
  it("extracts file paths from unified diff headers", () => {
    const paths = extractDiffFilePaths(PR_DIFF);
    expect(paths).toContain("skills/on-chain-monitor/SKILL.md");
  });

  it("returns empty set for non-diff input", () => {
    expect(extractDiffFilePaths("no diff headers here")).toEqual(new Set());
  });
});

describe("detectAbsorbedInline", () => {
  it("returns absorbed=false when there are no candidate commits", async () => {
    const deps = makeDeps({
      listRecentCommits: vi.fn().mockResolvedValue([]),
    });
    const result = await detectAbsorbedInline(PR_BASE, deps);
    expect(result.absorbed).toBe(false);
  });

  it("returns absorbed=false when PR diff is empty", async () => {
    const deps = makeDeps({
      getPrDiff: vi.fn().mockResolvedValue(""),
    });
    const result = await detectAbsorbedInline(PR_BASE, deps);
    expect(result.absorbed).toBe(false);
  });

  it("returns absorbed=false when no candidates have overlapping files", async () => {
    const deps = makeDeps({
      listRecentCommits: vi.fn().mockResolvedValue([
        { sha: "abc123", message: "update readme", date: "2026-05-19T00:00:00Z" },
      ]),
      getCommitFiles: vi.fn().mockResolvedValue(["README.md"]),
    });
    const result = await detectAbsorbedInline(PR_BASE, deps);
    expect(result.absorbed).toBe(false);
    expect(deps.judgeEquivalence).not.toHaveBeenCalled();
  });

  it("calls the judge only for candidates with overlapping files", async () => {
    const judge = vi.fn().mockResolvedValue({
      equivalent: true,
      confidence: 0.95,
      reasoning: "Same fix applied inline",
    });
    const deps = makeDeps({
      listRecentCommits: vi.fn().mockResolvedValue([
        { sha: "bab1e4b123", message: "add check: schema", date: "2026-05-19T00:00:00Z" },
      ]),
      getCommitFiles: vi.fn().mockResolvedValue(["skills/on-chain-monitor/SKILL.md"]),
      getCommitDiff: vi.fn().mockResolvedValue(MATCHING_COMMIT_DIFF),
      judgeEquivalence: judge,
    });
    const result = await detectAbsorbedInline(PR_BASE, deps);
    expect(result.absorbed).toBe(true);
    if (result.absorbed) {
      expect(result.commitSha).toBe("bab1e4b123");
      expect(result.confidence).toBe(0.95);
    }
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it("returns absorbed=false when judge says equivalent but confidence is below threshold", async () => {
    const deps = makeDeps({
      listRecentCommits: vi.fn().mockResolvedValue([
        { sha: "lowconf", message: "maybe related", date: "2026-05-19T00:00:00Z" },
      ]),
      getCommitFiles: vi.fn().mockResolvedValue(["skills/on-chain-monitor/SKILL.md"]),
      getCommitDiff: vi.fn().mockResolvedValue(MATCHING_COMMIT_DIFF),
      judgeEquivalence: vi.fn().mockResolvedValue({
        equivalent: true,
        confidence: 0.5,
        reasoning: "Partial match",
      }),
    });
    const result = await detectAbsorbedInline(PR_BASE, deps);
    expect(result.absorbed).toBe(false);
  });

  it("picks the highest-confidence match when multiple candidates are equivalent", async () => {
    const judge = vi
      .fn()
      .mockResolvedValueOnce({ equivalent: true, confidence: 0.8, reasoning: "Match A" })
      .mockResolvedValueOnce({ equivalent: true, confidence: 0.95, reasoning: "Match B" });
    const deps = makeDeps({
      listRecentCommits: vi.fn().mockResolvedValue([
        { sha: "sha-a", message: "commit a", date: "2026-05-19T00:00:00Z" },
        { sha: "sha-b", message: "commit b", date: "2026-05-19T01:00:00Z" },
      ]),
      getCommitFiles: vi.fn().mockResolvedValue(["skills/on-chain-monitor/SKILL.md"]),
      getCommitDiff: vi.fn().mockResolvedValue(MATCHING_COMMIT_DIFF),
      judgeEquivalence: judge,
    });
    const result = await detectAbsorbedInline(PR_BASE, deps);
    expect(result.absorbed).toBe(true);
    if (result.absorbed) {
      expect(result.commitSha).toBe("sha-b");
      expect(result.confidence).toBe(0.95);
    }
  });

  it("returns absorbed=false when PR diff fetch fails", async () => {
    const deps = makeDeps({
      getPrDiff: vi.fn().mockRejectedValue(new Error("404 Not Found")),
    });
    const result = await detectAbsorbedInline(PR_BASE, deps);
    expect(result.absorbed).toBe(false);
  });
});
