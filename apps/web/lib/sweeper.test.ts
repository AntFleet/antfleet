import { describe, expect, it, vi } from "vitest";
import {
  classifyFindings,
  detectClosuresWith,
  type FindingForClosureCheck,
} from "./sweeper";

const findings: FindingForClosureCheck[] = [
  { findingId: "abc12345-0", evidencePath: "src/handler.ts" },
  { findingId: "abc12345-1", evidencePath: "src/db.ts" },
  { findingId: "abc12345-2", evidencePath: "src/util.ts" },
];

describe("classifyFindings", () => {
  it("returns still_open for every finding when main hasn't diverged", () => {
    const out = classifyFindings({
      reviewCommitSha: "deadbeef",
      currentMainSha: "deadbeef",
      changedFiles: ["src/handler.ts"], // ignored when shas match
      findings,
    });
    expect(out.every((d) => d.status === "still_open")).toBe(true);
  });

  it("marks closed when the finding's evidence path is in the changed files", () => {
    const out = classifyFindings({
      reviewCommitSha: "old",
      currentMainSha: "new",
      changedFiles: ["src/handler.ts", "src/db.ts"],
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
      changedFiles: ["src/handler.ts"],
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
      changedFiles: ["docs/README.md", "src/unrelated.ts"],
      findings,
    });
    expect(out.every((d) => d.status === "still_open")).toBe(true);
  });

  it("handles empty findings input", () => {
    expect(
      classifyFindings({
        reviewCommitSha: "a",
        currentMainSha: "b",
        changedFiles: ["src/anything.ts"],
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

describe("detectClosuresWith", () => {
  const mkOctokit = (overrides: {
    refSha?: string;
    refThrows?: Error;
    changedFiles?: string[];
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
          return { data: { files: (overrides.changedFiles ?? []).map((f) => ({ filename: f })) } };
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
