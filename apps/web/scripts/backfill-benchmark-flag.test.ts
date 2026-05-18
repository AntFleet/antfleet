import { describe, expect, it, vi } from "vitest";
import {
  runBenchmarkBackfill,
  type BackfillDeps,
  type BenchmarkCheck,
  type CandidateGroup,
} from "./backfill-benchmark-flag";

function mkDeps(overrides: { groups: CandidateGroup[]; checks: Record<string, BenchmarkCheck> }): {
  deps: BackfillDeps;
  flipped: string[][];
  logs: string[];
} {
  const flipped: string[][] = [];
  const logs: string[] = [];
  const deps: BackfillDeps = {
    loadCandidateGroups: vi.fn().mockResolvedValue(overrides.groups),
    checkBenchmark: vi.fn().mockImplementation(async (owner: string, repo: string) => {
      const key = `${owner}/${repo}`;
      const result = overrides.checks[key];
      if (result === undefined) {
        throw new Error(`unexpected check for ${key}`);
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
  return { deps, flipped, logs };
}

describe("runBenchmarkBackfill", () => {
  it("flips only benchmark-class rows; leaves non-benchmark untouched", async () => {
    const { deps, flipped } = mkDeps({
      groups: [
        { owner: "alice", repo: "bench-fork", reviewIds: ["r1", "r2"] },
        { owner: "alice", repo: "regular-app", reviewIds: ["r3"] },
        { owner: "bob", repo: "another-bench", reviewIds: ["r4", "r5"] },
      ],
      checks: {
        "alice/bench-fork": { kind: "benchmark" },
        "alice/regular-app": { kind: "not_benchmark" },
        "bob/another-bench": { kind: "benchmark" },
      },
    });

    const summary = await runBenchmarkBackfill(deps, { dryRun: false });

    expect(flipped).toEqual([
      ["r1", "r2"],
      ["r4", "r5"],
    ]);
    expect(summary.benchmarkGroups).toBe(2);
    expect(summary.nonBenchmarkGroups).toBe(1);
    expect(summary.errorGroups).toBe(0);
    expect(summary.rowsFlipped).toBe(4);

    const nonBenchDecision = summary.decisions.find((d) => d.repo === "regular-app");
    expect(nonBenchDecision?.decision).toBe("not_benchmark");
    expect(nonBenchDecision?.flipped).toBe(0);
  });

  it("does not call flipRows on already-empty candidate set", async () => {
    const { deps, flipped } = mkDeps({ groups: [], checks: {} });
    const summary = await runBenchmarkBackfill(deps, { dryRun: false });
    expect(flipped).toEqual([]);
    expect(summary.preState.totalGroups).toBe(0);
    expect(summary.preState.totalCandidateRows).toBe(0);
    expect(summary.rowsFlipped).toBe(0);
  });

  it("captures probe errors as 'error' decisions; rows untouched", async () => {
    const { deps, flipped } = mkDeps({
      groups: [
        { owner: "alice", repo: "bench-fork", reviewIds: ["r1"] },
        { owner: "broken", repo: "rate-limited", reviewIds: ["r2", "r3"] },
      ],
      checks: {
        "alice/bench-fork": { kind: "benchmark" },
        "broken/rate-limited": { kind: "error", error: "rate limit exceeded" },
      },
    });

    const summary = await runBenchmarkBackfill(deps, { dryRun: false });

    expect(flipped).toEqual([["r1"]]);
    expect(summary.benchmarkGroups).toBe(1);
    expect(summary.errorGroups).toBe(1);
    expect(summary.rowsFlipped).toBe(1);

    const errorDecision = summary.decisions.find((d) => d.repo === "rate-limited");
    expect(errorDecision?.decision).toBe("error");
    expect(errorDecision?.error).toBe("rate limit exceeded");
    expect(errorDecision?.flipped).toBe(0);
  });

  it("--dry-run produces decisions without calling flipRows", async () => {
    const { deps, flipped } = mkDeps({
      groups: [{ owner: "alice", repo: "bench-fork", reviewIds: ["r1", "r2", "r3"] }],
      checks: {
        "alice/bench-fork": { kind: "benchmark" },
      },
    });

    const summary = await runBenchmarkBackfill(deps, { dryRun: true });

    expect(flipped).toEqual([]);
    expect(summary.benchmarkGroups).toBe(1);
    expect(summary.rowsFlipped).toBe(0);
    expect(summary.dryRun).toBe(true);
    // The decisions still report the counterfactual count so operator can
    // see what WOULD have been flipped.
    expect(summary.decisions[0]?.flipped).toBe(3);
  });

  it("logs pre-state and post-state lines", async () => {
    const { deps, logs } = mkDeps({
      groups: [{ owner: "alice", repo: "bench-fork", reviewIds: ["r1"] }],
      checks: { "alice/bench-fork": { kind: "benchmark" } },
    });

    await runBenchmarkBackfill(deps, { dryRun: false });

    expect(logs.some((l) => l.startsWith("[pre-state]"))).toBe(true);
    expect(logs.some((l) => l.startsWith("[post-state]"))).toBe(true);
  });

  it("dry-run log includes [mode] dry-run banner", async () => {
    const { deps, logs } = mkDeps({
      groups: [{ owner: "alice", repo: "bench-fork", reviewIds: ["r1"] }],
      checks: { "alice/bench-fork": { kind: "benchmark" } },
    });

    await runBenchmarkBackfill(deps, { dryRun: true });

    expect(logs.some((l) => l.includes("dry-run"))).toBe(true);
  });
});
