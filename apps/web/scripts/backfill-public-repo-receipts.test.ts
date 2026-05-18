import { describe, expect, it, vi } from "vitest";
import {
  runBackfill,
  type BackfillDeps,
  type CandidateGroup,
  type VisibilityCheck,
} from "./backfill-public-repo-receipts";

function mkDeps(overrides: {
  groups: CandidateGroup[];
  visibility: Record<string, VisibilityCheck>;
}): {
  deps: BackfillDeps;
  flipped: string[][];
  logs: string[];
  visibilityCalls: Array<{ installationId: number; owner: string; repo: string }>;
} {
  const flipped: string[][] = [];
  const logs: string[] = [];
  const visibilityCalls: Array<{
    installationId: number;
    owner: string;
    repo: string;
  }> = [];
  const deps: BackfillDeps = {
    loadCandidateGroups: vi.fn().mockResolvedValue(overrides.groups),
    checkVisibility: vi.fn().mockImplementation(async (installationId, owner, repo) => {
      visibilityCalls.push({ installationId, owner, repo });
      const key = `${owner}/${repo}`;
      const result = overrides.visibility[key];
      if (result === undefined) {
        throw new Error(`unexpected visibility lookup for ${key}`);
      }
      return result;
    }),
    flipRows: vi.fn().mockImplementation(async (ids: string[]) => {
      flipped.push(ids);
      return ids.length;
    }),
    log: (line: string) => {
      logs.push(line);
    },
  };
  return { deps, flipped, logs, visibilityCalls };
}

describe("runBackfill", () => {
  it("flips only public-repo rows; leaves private rows untouched", async () => {
    const { deps, flipped, logs } = mkDeps({
      groups: [
        { installationId: 1, owner: "alice", repo: "open-src", reviewIds: ["r1", "r2"] },
        { installationId: 1, owner: "alice", repo: "secret-app", reviewIds: ["r3"] },
        { installationId: 2, owner: "bob", repo: "pub", reviewIds: ["r4", "r5", "r6"] },
      ],
      visibility: {
        "alice/open-src": { kind: "public" },
        "alice/secret-app": { kind: "private" },
        "bob/pub": { kind: "public" },
      },
    });

    const summary = await runBackfill(deps, { dryRun: false });

    expect(flipped).toEqual([
      ["r1", "r2"],
      ["r4", "r5", "r6"],
    ]);
    expect(summary.publicGroups).toBe(2);
    expect(summary.privateGroups).toBe(1);
    expect(summary.errorGroups).toBe(0);
    expect(summary.rowsFlipped).toBe(5);
    // Private repo's decision exists in the report so the operator can
    // confirm no private repo was flipped.
    const privateDecision = summary.decisions.find(
      (d) => d.owner === "alice" && d.repo === "secret-app",
    );
    expect(privateDecision?.decision).toBe("private");
    expect(privateDecision?.flipped).toBe(0);
    // Some pre/post state lines should have made it into the log.
    expect(logs.some((l) => l.startsWith("[pre-state]"))).toBe(true);
    expect(logs.some((l) => l.startsWith("[post-state]"))).toBe(true);
  });

  it("already-public rows never appear as candidates (idempotency)", async () => {
    // loadCandidateGroups is responsible for filtering publicReceipt=false;
    // here we model that contract by feeding an empty group set, which
    // mirrors what the DB query returns when every row is already public.
    const { deps, flipped } = mkDeps({ groups: [], visibility: {} });

    const summary = await runBackfill(deps, { dryRun: false });

    expect(summary.rowsFlipped).toBe(0);
    expect(summary.publicGroups).toBe(0);
    expect(summary.privateGroups).toBe(0);
    expect(summary.errorGroups).toBe(0);
    expect(flipped).toEqual([]);
  });

  it("treats Octokit errors as 'leave untouched' with a warning, never as 'public'", async () => {
    const { deps, flipped, logs } = mkDeps({
      groups: [
        { installationId: 1, owner: "alice", repo: "404-repo", reviewIds: ["r1"] },
        { installationId: 2, owner: "bob", repo: "fine", reviewIds: ["r2", "r3"] },
      ],
      visibility: {
        "alice/404-repo": { kind: "error", error: "Not Found" },
        "bob/fine": { kind: "public" },
      },
    });

    const summary = await runBackfill(deps, { dryRun: false });

    expect(flipped).toEqual([["r2", "r3"]]);
    expect(summary.errorGroups).toBe(1);
    expect(summary.publicGroups).toBe(1);
    expect(summary.rowsFlipped).toBe(2);
    const errorDecision = summary.decisions.find((d) => d.repo === "404-repo");
    expect(errorDecision?.decision).toBe("error");
    expect(errorDecision?.error).toBe("Not Found");
    expect(errorDecision?.flipped).toBe(0);
    expect(logs.some((l) => l.includes("Not Found"))).toBe(true);
  });

  it("dry-run never writes; still reports counterfactual counts", async () => {
    const { deps, flipped } = mkDeps({
      groups: [
        { installationId: 1, owner: "alice", repo: "open-src", reviewIds: ["r1", "r2"] },
        { installationId: 1, owner: "alice", repo: "secret-app", reviewIds: ["r3"] },
      ],
      visibility: {
        "alice/open-src": { kind: "public" },
        "alice/secret-app": { kind: "private" },
      },
    });

    const summary = await runBackfill(deps, { dryRun: true });

    expect(flipped).toEqual([]);
    expect(summary.dryRun).toBe(true);
    // rowsFlipped reflects what actually changed (0); per-group flipped
    // reflects what would have changed, so the operator can read the size
    // of the impending write.
    expect(summary.rowsFlipped).toBe(0);
    const publicDecision = summary.decisions.find((d) => d.repo === "open-src");
    expect(publicDecision?.flipped).toBe(2);
  });

  it("memoizes nothing on its own — visits every group's checkVisibility once", async () => {
    // No grouping deduplication concerns since loadCandidateGroups already
    // groups by (installationId, owner, repo). We just verify runBackfill
    // does not call checkVisibility twice for the same group.
    const { deps, visibilityCalls } = mkDeps({
      groups: [
        { installationId: 1, owner: "alice", repo: "a", reviewIds: ["r1"] },
        { installationId: 1, owner: "alice", repo: "b", reviewIds: ["r2"] },
      ],
      visibility: {
        "alice/a": { kind: "public" },
        "alice/b": { kind: "private" },
      },
    });

    await runBackfill(deps, { dryRun: false });

    expect(visibilityCalls).toHaveLength(2);
    expect(visibilityCalls[0]).toEqual({ installationId: 1, owner: "alice", repo: "a" });
    expect(visibilityCalls[1]).toEqual({ installationId: 1, owner: "alice", repo: "b" });
  });
});
