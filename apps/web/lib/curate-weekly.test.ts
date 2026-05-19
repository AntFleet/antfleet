import type { Pool } from "@neondatabase/serverless";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  compareCandidates,
  curateWeekly,
  currentIsoWeekMondayUtc,
  type CandidateRow,
} from "./curate-weekly";

vi.mock("./post-drafts", () => ({
  writeWeeklyFeatureDraft: vi.fn().mockResolvedValue("/tmp/weekly.md"),
}));

vi.mock("./log", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  messageOf: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

function row(overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    finding_id: "finding-a",
    agent_name: "Agent A",
    agent_token_address: "0xagent",
    title: "Finding A",
    severity: "low",
    summary: "Summary",
    upstream_pr_url: null,
    upstream_merged_sha: null,
    published_at: new Date("2026-05-18T12:00:00.000Z"),
    ...overrides,
  };
}

function fakePool(results: Array<{ rows: unknown[] }>): Pool {
  return {
    query: vi.fn().mockImplementation(() => {
      const result = results.shift();
      if (result === undefined) throw new Error("unexpected query");
      return Promise.resolve(result);
    }),
  } as unknown as Pool;
}

describe("currentIsoWeekMondayUtc", () => {
  it("keeps Sunday 23:59 UTC in the previous ISO week", () => {
    expect(currentIsoWeekMondayUtc(new Date("2026-05-17T23:59:00.000Z"))).toBe("2026-05-11");
  });

  it("uses Monday 00:00 UTC as that week's boundary", () => {
    expect(currentIsoWeekMondayUtc(new Date("2026-05-18T00:00:00.000Z"))).toBe("2026-05-18");
  });
});

describe("compareCandidates", () => {
  it("orders by severity, upstream PR, merge sha, then recency", () => {
    const ranked = [
      row({
        finding_id: "old-low",
        severity: "low",
        published_at: new Date("2026-05-10T00:00:00Z"),
      }),
      row({ finding_id: "high-no-pr", severity: "high", upstream_pr_url: null }),
      row({
        finding_id: "high-pr",
        severity: "high",
        upstream_pr_url: "https://github.com/o/r/pull/1",
      }),
      row({
        finding_id: "high-merged-old",
        severity: "high",
        upstream_pr_url: "https://github.com/o/r/pull/2",
        upstream_merged_sha: "abc",
        published_at: new Date("2026-05-17T00:00:00Z"),
      }),
      row({
        finding_id: "high-merged-new",
        severity: "high",
        upstream_pr_url: "https://github.com/o/r/pull/3",
        upstream_merged_sha: "def",
        published_at: new Date("2026-05-18T00:00:00Z"),
      }),
    ].toSorted(compareCandidates);

    expect(ranked.map((candidate) => candidate.finding_id)).toEqual([
      "high-merged-new",
      "high-merged-old",
      "high-pr",
      "high-no-pr",
      "old-low",
    ]);
  });
});

describe("curateWeekly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns skipped_existing when this week already has a feature", async () => {
    const result = await curateWeekly({
      pool: fakePool([{ rows: [{ count: 1 }] }]),
      apply: true,
      now: new Date("2026-05-18T00:00:00Z"),
    });
    expect(result).toEqual({ status: "skipped_existing", weekStart: "2026-05-18" });
  });

  it("returns no_candidates when the candidate query is empty", async () => {
    const result = await curateWeekly({
      pool: fakePool([{ rows: [{ count: 0 }] }, { rows: [] }]),
      apply: true,
      now: new Date("2026-05-18T00:00:00Z"),
    });
    expect(result).toEqual({ status: "no_candidates", weekStart: "2026-05-18" });
  });

  it("returns dry_run with the picked finding and rationale", async () => {
    const result = await curateWeekly({
      pool: fakePool([{ rows: [{ count: 0 }] }, { rows: [row({ severity: "high" })] }]),
      apply: false,
      now: new Date("2026-05-18T00:00:00Z"),
    });
    expect(result).toEqual({
      status: "dry_run",
      weekStart: "2026-05-18",
      pickedFindingId: "finding-a",
      rationale: "auto: high · published 2026-05-18",
    });
  });

  it("inserts and returns featured when apply is true", async () => {
    const result = await curateWeekly({
      pool: fakePool([
        { rows: [{ count: 0 }] },
        { rows: [row({ severity: "high", upstream_pr_url: "https://github.com/o/r/pull/1" })] },
        { rows: [] },
      ]),
      apply: true,
      now: new Date("2026-05-18T00:00:00Z"),
    });
    expect(result).toEqual({
      status: "featured",
      weekStart: "2026-05-18",
      pickedFindingId: "finding-a",
      rationale: "auto: high · upstream PR open · published 2026-05-18",
      draftPath: "/tmp/weekly.md",
    });
  });
});
