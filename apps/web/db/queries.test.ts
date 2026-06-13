import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => {
  const setCalls: unknown[] = [];
  const where = vi.fn(() => Promise.resolve());
  const set = vi.fn((values: unknown) => {
    setCalls.push(values);
    return { where };
  });
  const update = vi.fn(() => ({ set }));
  const selectWhereCalls: unknown[] = [];
  const selectLimit = vi.fn(() => Promise.resolve([]));
  const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
  const selectWhere = vi.fn((arg: unknown) => {
    selectWhereCalls.push(arg);
    return { orderBy: selectOrderBy };
  });
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));
  return {
    db: { update, select },
    setCalls,
    set,
    update,
    where,
    select,
    selectFrom,
    selectWhere,
    selectOrderBy,
    selectLimit,
    selectWhereCalls,
  };
});

vi.mock("./index", () => ({ db: dbMocks.db }));

import {
  isMissingPatchRationaleColumnError,
  isMissingPatchSkipReasonColumnError,
  loadReviewsReadyForRetry,
  normalizeActivityWindow,
  recordPatchDecisions,
  summarizeRoastFindings,
} from "./queries";
import { MAX_PROCESSING_ATTEMPTS } from "@/lib/review-worker-config";

const NOW = new Date("2026-05-19T12:00:00.000Z");

beforeEach(() => {
  dbMocks.setCalls.length = 0;
  dbMocks.update.mockClear();
  dbMocks.set.mockClear();
  dbMocks.where.mockClear();
});

describe("normalizeActivityWindow", () => {
  it("passes both-null through (all-time window)", () => {
    const out = normalizeActivityWindow(null, null, NOW);
    expect(out).toEqual({ since: null, until: null, zero: false });
  });

  it("passes since-only through unchanged (open-ended upper bound)", () => {
    const since = new Date("2026-05-12T00:00:00.000Z");
    const out = normalizeActivityWindow(since, null, NOW);
    expect(out).toEqual({ since, until: null, zero: false });
  });

  it("passes until-only through unchanged (open-ended lower bound)", () => {
    const until = new Date("2026-05-15T00:00:00.000Z");
    const out = normalizeActivityWindow(null, until, NOW);
    expect(out).toEqual({ since: null, until, zero: false });
  });

  it("passes a fully-bounded past window through unchanged", () => {
    const since = new Date("2026-05-09T00:00:00.000Z");
    const until = new Date("2026-05-16T00:00:00.000Z");
    const out = normalizeActivityWindow(since, until, NOW);
    expect(out).toEqual({ since, until, zero: false });
  });

  it("clamps an until that lands in the future to null (open-ended)", () => {
    const since = new Date("2026-05-12T00:00:00.000Z");
    const futureUntil = new Date("2027-01-01T00:00:00.000Z");
    const out = normalizeActivityWindow(since, futureUntil, NOW);
    expect(out).toEqual({ since, until: null, zero: false });
  });

  it("returns zero=true when until < since (impossible window)", () => {
    const since = new Date("2026-05-15T00:00:00.000Z");
    const until = new Date("2026-05-10T00:00:00.000Z");
    const out = normalizeActivityWindow(since, until, NOW);
    expect(out).toEqual({ since: null, until: null, zero: true });
  });

  it("does NOT zero out an equal since/until pair (single instant window)", () => {
    // A weekly digest at midnight would otherwise wipe itself on the
    // boundary moment. since == until is "no rows" SQL-wise but not the
    // impossible-range sentinel.
    const ts = new Date("2026-05-12T00:00:00.000Z");
    const out = normalizeActivityWindow(ts, ts, NOW);
    expect(out).toEqual({ since: ts, until: ts, zero: false });
  });

  it("does NOT clamp an until that is exactly equal to now", () => {
    const out = normalizeActivityWindow(null, NOW, NOW);
    expect(out).toEqual({ since: null, until: NOW, zero: false });
  });
});

describe("summarizeRoastFindings", () => {
  it("counts findings and picks the highest severity by rank", () => {
    expect(
      summarizeRoastFindings([{ severity: "low" }, { severity: "high" }, { severity: "med" }]),
    ).toEqual({ findingCount: 3, highestSeverity: "high" });
  });

  it("returns null severity when no findings exist", () => {
    expect(summarizeRoastFindings([])).toEqual({ findingCount: 0, highestSeverity: null });
  });

  it("ignores unknown severities when choosing the highest ranked label", () => {
    expect(summarizeRoastFindings([{ severity: "experimental" }])).toEqual({
      findingCount: 1,
      highestSeverity: null,
    });
  });
});

describe("recordPatchDecisions", () => {
  it("writes per-side skip reasons with the optional rationale columns", async () => {
    await recordPatchDecisions([
      {
        findingId: "rev-1-0",
        suggestedPatch: null,
        patchModelId: null,
        patchSkipReason: "models_disagreed",
        proposedAt: NOW,
        candidates: { opus: "-old\n+new\n", gpt5: null },
        rationales: { opus: "safe fix", gpt5: null },
        skipReasons: { opus: null, gpt5: "generation_error" },
        selector: "no-gpt5-deterministic-skip",
      },
    ]);

    expect(dbMocks.setCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          patchRationaleOpus: "safe fix",
          patchRationaleGpt5: null,
        }),
        expect.objectContaining({
          patchSkipReasonOpus: null,
          patchSkipReasonGpt5: "generation_error",
        }),
      ]),
    );
  });

  it("writes NULL per-side skip reasons when omitted", async () => {
    await recordPatchDecisions([
      {
        findingId: "rev-1-0",
        suggestedPatch: "-old\n+new\n",
        patchModelId: "claude-opus-4-7",
        patchSkipReason: null,
        proposedAt: NOW,
        candidates: { opus: "-old\n+new\n", gpt5: "-old\n+other\n" },
        selector: "deterministic-opus",
      },
    ]);

    expect(dbMocks.setCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          patchRationaleOpus: null,
          patchRationaleGpt5: null,
        }),
        expect.objectContaining({
          patchSkipReasonOpus: null,
          patchSkipReasonGpt5: null,
        }),
      ]),
    );
  });
});

describe("loadReviewsReadyForRetry", () => {
  it("filters out rows that have hit the attempts cap", async () => {
    dbMocks.selectWhereCalls.length = 0;
    await loadReviewsReadyForRetry({ now: NOW, stuckBefore: NOW, limit: 10 });
    expect(dbMocks.selectWhereCalls).toHaveLength(1);
    // The composed `and(...)` predicate exposes its children via queryChunks.
    // We walk it for a chunk that references the processing_attempts column
    // and pairs it with the MAX_PROCESSING_ATTEMPTS literal so a future
    // refactor that drops the cap from the WHERE will fail this.
    const seenColumns = new Set<string>();
    const seenParams = new Set<string>();
    const visited = new WeakSet<object>();
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") {
        if (node !== undefined) seenParams.add(String(node));
        return;
      }
      if (visited.has(node as object)) return;
      visited.add(node as object);
      if ("name" in node && typeof (node as { name?: unknown }).name === "string") {
        seenColumns.add((node as { name: string }).name);
      }
      for (const v of Object.values(node)) walk(v);
    };
    walk(dbMocks.selectWhereCalls[0]);
    expect(seenColumns.has("processing_attempts")).toBe(true);
    expect(seenParams.has(String(MAX_PROCESSING_ATTEMPTS))).toBe(true);
  });
});

describe("isMissingPatchRationaleColumnError", () => {
  it("matches undefined-column errors for the additive rationale columns", () => {
    expect(
      isMissingPatchRationaleColumnError({
        code: "42703",
        message: 'column "patch_rationale_gpt5" of relation "finding_status" does not exist',
      }),
    ).toBe(true);
  });

  it("does not hide unrelated undefined-column errors", () => {
    expect(
      isMissingPatchRationaleColumnError({
        code: "42703",
        message: 'column "suggested_patch_gpt5" of relation "finding_status" does not exist',
      }),
    ).toBe(false);
  });
});

describe("isMissingPatchSkipReasonColumnError", () => {
  it("matches undefined-column errors for additive per-side skip-reason columns", () => {
    expect(
      isMissingPatchSkipReasonColumnError({
        code: "42703",
        message: 'column "patch_skip_reason_opus" of relation "finding_status" does not exist',
      }),
    ).toBe(true);
    expect(
      isMissingPatchSkipReasonColumnError({
        code: "42703",
        message: 'column "patch_skip_reason_gpt5" of relation "finding_status" does not exist',
      }),
    ).toBe(true);
  });

  it("does not hide missing rationale columns", () => {
    expect(
      isMissingPatchSkipReasonColumnError({
        code: "42703",
        message: 'column "patch_rationale_gpt5" of relation "finding_status" does not exist',
      }),
    ).toBe(false);
  });

  it("keeps the rationale predicate narrow", () => {
    expect(
      isMissingPatchRationaleColumnError({
        code: "42703",
        message: 'column "patch_skip_reason_gpt5" of relation "finding_status" does not exist',
      }),
    ).toBe(false);
  });
});
