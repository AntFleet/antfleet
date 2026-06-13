import { describe, expect, it, vi } from "vitest";
import {
  classifyFindings,
  detectClosuresWith,
  type ChangedFile,
  type FindingForClosureCheck,
} from "./sweeper";

// Legacy findings without a line range — exercises the file-changed fallback.
// Pre-T3.3 closure semantics: a file touch closes the finding.
const findings: FindingForClosureCheck[] = [
  { findingId: "abc12345-0", evidencePath: "src/handler.ts", startLine: null, endLine: null },
  { findingId: "abc12345-1", evidencePath: "src/db.ts", startLine: null, endLine: null },
  { findingId: "abc12345-2", evidencePath: "src/util.ts", startLine: null, endLine: null },
];

// Helper to wrap a path into the file-changed shape used by classifyFindings.
// No patch field — exercises the binary-file / oversized-diff fallback path.
function file(filename: string, patch?: string): ChangedFile {
  return patch === undefined ? { filename } : { filename, patch };
}

describe("classifyFindings", () => {
  it("returns still_open for every finding when main hasn't diverged", () => {
    const out = classifyFindings({
      reviewCommitSha: "deadbeef",
      currentMainSha: "deadbeef",
      changedFiles: [file("src/handler.ts")], // ignored when shas match
      findings,
    });
    expect(out.every((d) => d.status === "still_open")).toBe(true);
  });

  it("marks closed when the finding's evidence path is in the changed files (legacy fallback)", () => {
    const out = classifyFindings({
      reviewCommitSha: "old",
      currentMainSha: "new",
      changedFiles: [file("src/handler.ts"), file("src/db.ts")],
      findings,
    });
    const byId = Object.fromEntries(out.map((d) => [d.findingId, d]));
    expect(byId["abc12345-0"]?.status).toBe("closed");
    expect(byId["abc12345-1"]?.status).toBe("closed");
    expect(byId["abc12345-2"]?.status).toBe("still_open");
  });

  it("uses the current main SHA as closure_sha on closed findings", () => {
    const out = classifyFindings({
      reviewCommitSha: "old",
      currentMainSha: "new-head-sha",
      changedFiles: [file("src/handler.ts")],
      findings: [findings[0]!],
    });
    expect(out[0]).toEqual({
      findingId: "abc12345-0",
      status: "closed",
      closureSha: "new-head-sha",
    });
  });

  it("keeps a finding still_open when its specific file is untouched even if other files changed", () => {
    const out = classifyFindings({
      reviewCommitSha: "old",
      currentMainSha: "new",
      changedFiles: [file("docs/README.md"), file("src/unrelated.ts")],
      findings,
    });
    expect(out.every((d) => d.status === "still_open")).toBe(true);
  });

  it("handles empty findings input", () => {
    expect(
      classifyFindings({
        reviewCommitSha: "a",
        currentMainSha: "b",
        changedFiles: [file("src/anything.ts")],
        findings: [],
      }),
    ).toEqual([]);
  });

  it("handles empty changedFiles list (e.g. main advanced via commits that touched no source)", () => {
    const out = classifyFindings({
      reviewCommitSha: "old",
      currentMainSha: "new",
      changedFiles: [],
      findings,
    });
    expect(out.every((d) => d.status === "still_open")).toBe(true);
  });
});

// T3.3 — Option B line-range overlap. The pure classifier now consumes
// per-file hunk patches and narrows closure to findings whose original
// evidence line range was actually touched.
describe("classifyFindings — Option B line-range overlap (T3.3)", () => {
  // Finding spans lines 20-35 of handler.ts.
  const lineFinding: FindingForClosureCheck = {
    findingId: "lf-1",
    evidencePath: "src/handler.ts",
    startLine: 20,
    endLine: 35,
  };

  it("keeps finding still_open when the file changed but the hunk does NOT overlap the line range", () => {
    // Hunk modifies lines 100-104; finding is at 20-35.
    const patch = "@@ -100,5 +100,5 @@\n line\n line\n-line\n+line\n line\n";
    const out = classifyFindings({
      reviewCommitSha: "old",
      currentMainSha: "new",
      changedFiles: [file("src/handler.ts", patch)],
      findings: [lineFinding],
    });
    expect(out[0]?.status).toBe("still_open");
  });

  it("closes finding when a hunk overlaps the line range", () => {
    // Hunk touches lines 25-28, inside the 20-35 finding range.
    const patch = "@@ -25,4 +25,4 @@\n line\n-line\n+line\n line\n line\n";
    const out = classifyFindings({
      reviewCommitSha: "old",
      currentMainSha: "headsha",
      changedFiles: [file("src/handler.ts", patch)],
      findings: [lineFinding],
    });
    expect(out[0]).toEqual({ findingId: "lf-1", status: "closed", closureSha: "headsha" });
  });

  it("closes finding when ONE OF multiple hunks overlaps the line range", () => {
    // Two hunks: one at lines 5-7 (no overlap), one at lines 30-32 (overlaps 20-35).
    const patch =
      "@@ -5,3 +5,3 @@\n line\n-old\n+new\n line\n@@ -30,3 +30,3 @@\n line\n-old\n+new\n line\n";
    const out = classifyFindings({
      reviewCommitSha: "old",
      currentMainSha: "new",
      changedFiles: [file("src/handler.ts", patch)],
      findings: [lineFinding],
    });
    expect(out[0]?.status).toBe("closed");
  });

  it("legacy finding without line range falls back to file-changed (closed when file touched)", () => {
    // Unrelated edit elsewhere in the file, but legacy row → file-changed closes.
    const patch = "@@ -500,1 +500,1 @@\n-line\n+line\n";
    const legacy: FindingForClosureCheck = {
      findingId: "legacy-1",
      evidencePath: "src/handler.ts",
      startLine: null,
      endLine: null,
    };
    const out = classifyFindings({
      reviewCommitSha: "old",
      currentMainSha: "new",
      changedFiles: [file("src/handler.ts", patch)],
      findings: [legacy],
    });
    expect(out[0]?.status).toBe("closed");
  });

  it("falls back to file-changed when the file entry has no patch (binary / oversized diff)", () => {
    // patch field omitted — must NOT silently mark still_open. Treat as
    // "file changed" per the falback rule.
    const out = classifyFindings({
      reviewCommitSha: "old",
      currentMainSha: "new",
      changedFiles: [file("src/handler.ts" /* no patch */)],
      findings: [lineFinding],
    });
    expect(out[0]?.status).toBe("closed");
  });

  it("falls back to file-changed when patch is an empty string (defensive)", () => {
    const out = classifyFindings({
      reviewCommitSha: "old",
      currentMainSha: "new",
      changedFiles: [file("src/handler.ts", "")],
      findings: [lineFinding],
    });
    expect(out[0]?.status).toBe("closed");
  });

  it("only closes line-range findings whose own file matched (mixed batch)", () => {
    const patchHandler = "@@ -25,3 +25,3 @@\n line\n-x\n+y\n line\n";
    // dbFinding's file is in the changedFiles set but the file's patch
    // doesn't touch its line range — should remain still_open.
    const patchDb = "@@ -200,1 +200,1 @@\n-x\n+y\n";
    const dbFinding: FindingForClosureCheck = {
      findingId: "db-1",
      evidencePath: "src/db.ts",
      startLine: 5,
      endLine: 10,
    };
    const out = classifyFindings({
      reviewCommitSha: "old",
      currentMainSha: "new",
      changedFiles: [file("src/handler.ts", patchHandler), file("src/db.ts", patchDb)],
      findings: [lineFinding, dbFinding],
    });
    const byId = Object.fromEntries(out.map((d) => [d.findingId, d]));
    expect(byId["lf-1"]?.status).toBe("closed");
    expect(byId["db-1"]?.status).toBe("still_open");
  });
});

describe("detectClosuresWith", () => {
  // mkOctokit accepts either `changedFiles` (plain string list — no patch,
  // exercises the file-changed fallback) or `changedFileObjects` (full
  // {filename, patch?} list for hunk-overlap tests).
  const mkOctokit = (overrides: {
    refSha?: string;
    refThrows?: Error;
    changedFiles?: string[];
    changedFileObjects?: Array<{ filename: string; patch?: string }>;
    compareThrows?: Error;
  }) => ({
    rest: {
      git: {
        getRef: vi.fn().mockImplementation(async () => {
          if (overrides.refThrows) throw overrides.refThrows;
          return { data: { object: { sha: overrides.refSha ?? "new" } } };
        }),
      },
      repos: {
        compareCommits: vi.fn().mockImplementation(async () => {
          if (overrides.compareThrows) throw overrides.compareThrows;
          const files =
            overrides.changedFileObjects ??
            (overrides.changedFiles ?? []).map((f) => ({ filename: f }));
          return { data: { files } };
        }),
      },
    },
  });

  it("short-circuits with empty input", async () => {
    const octokit = mkOctokit({});
    const result = await detectClosuresWith(octokit, {
      owner: "o",
      repo: "r",
      reviewCommitSha: "x",
      findings: [],
    });
    expect(result).toEqual([]);
    expect(octokit.rest.git.getRef).not.toHaveBeenCalled();
  });

  it("marks all indeterminate when main ref is unavailable", async () => {
    const octokit = mkOctokit({ refThrows: new Error("404 not found") });
    const result = await detectClosuresWith(octokit, {
      owner: "o",
      repo: "r",
      reviewCommitSha: "x",
      findings,
    });
    expect(result.every((d) => d.status === "indeterminate")).toBe(true);
    expect(result[0]).toMatchObject({ reason: expect.stringContaining("main ref unavailable") });
  });

  it("marks all still_open when main has not advanced past the review sha", async () => {
    const octokit = mkOctokit({ refSha: "same-sha", changedFiles: ["src/handler.ts"] });
    const result = await detectClosuresWith(octokit, {
      owner: "o",
      repo: "r",
      reviewCommitSha: "same-sha",
      findings,
    });
    expect(result.every((d) => d.status === "still_open")).toBe(true);
    // compareCommits should not be invoked when SHAs are equal.
    expect(octokit.rest.repos.compareCommits).not.toHaveBeenCalled();
  });

  it("marks indeterminate when compareCommits errors (network/permission)", async () => {
    const octokit = mkOctokit({ refSha: "new", compareThrows: new Error("forbidden") });
    const result = await detectClosuresWith(octokit, {
      owner: "o",
      repo: "r",
      reviewCommitSha: "old",
      findings,
    });
    expect(result.every((d) => d.status === "indeterminate")).toBe(true);
    expect(result[0]).toMatchObject({ reason: expect.stringContaining("compareCommits failed") });
  });

  it("classifies via the pure path when ref + compare both succeed", async () => {
    const octokit = mkOctokit({
      refSha: "new-head",
      changedFiles: ["src/db.ts"],
    });
    const result = await detectClosuresWith(octokit, {
      owner: "o",
      repo: "r",
      reviewCommitSha: "old",
      findings,
    });
    const byId = Object.fromEntries(result.map((d) => [d.findingId, d]));
    expect(byId["abc12345-1"]).toEqual({
      findingId: "abc12345-1",
      status: "closed",
      closureSha: "new-head",
    });
    expect(byId["abc12345-0"]?.status).toBe("still_open");
    expect(byId["abc12345-2"]?.status).toBe("still_open");
  });

  it("threads per-file patches into classifyFindings for hunk-overlap (T3.3)", async () => {
    // Hunk touches lines 25-27 — overlaps the finding's 20-35 range.
    const patch = "@@ -25,3 +25,3 @@\n line\n-old\n+new\n line\n";
    const octokit = mkOctokit({
      refSha: "new-head",
      changedFileObjects: [{ filename: "src/handler.ts", patch }],
    });
    const lineFinding: FindingForClosureCheck = {
      findingId: "lf-1",
      evidencePath: "src/handler.ts",
      startLine: 20,
      endLine: 35,
    };
    const result = await detectClosuresWith(octokit, {
      owner: "o",
      repo: "r",
      reviewCommitSha: "old",
      findings: [lineFinding],
    });
    expect(result[0]).toEqual({ findingId: "lf-1", status: "closed", closureSha: "new-head" });
  });

  it("does NOT close a finding when patch hunks miss its line range (T3.3)", async () => {
    // Hunk at lines 100-102; finding lives at lines 20-35 — unrelated edit.
    const patch = "@@ -100,3 +100,3 @@\n line\n-old\n+new\n line\n";
    const octokit = mkOctokit({
      refSha: "new-head",
      changedFileObjects: [{ filename: "src/handler.ts", patch }],
    });
    const lineFinding: FindingForClosureCheck = {
      findingId: "lf-2",
      evidencePath: "src/handler.ts",
      startLine: 20,
      endLine: 35,
    };
    const result = await detectClosuresWith(octokit, {
      owner: "o",
      repo: "r",
      reviewCommitSha: "old",
      findings: [lineFinding],
    });
    expect(result[0]?.status).toBe("still_open");
  });

  it("honors a custom baseBranch", async () => {
    const octokit = mkOctokit({ refSha: "trunk-head", changedFiles: ["src/handler.ts"] });
    const result = await detectClosuresWith(octokit, {
      owner: "o",
      repo: "r",
      reviewCommitSha: "older",
      findings: [findings[0]!],
      baseBranch: "trunk",
    });
    expect(octokit.rest.git.getRef).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: "heads/trunk",
    });
    expect(result[0]?.status).toBe("closed");
  });
});
