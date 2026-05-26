import { describe, it, expect } from "vitest";
import {
  aggregatePayload,
  parseWeekEndingDate,
  weekEndingSunday,
} from "./scorecard";

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

describe("parseWeekEndingDate", () => {
  it("accepts a valid Sunday", () => {
    // 2026-05-24 is a Sunday
    const d = parseWeekEndingDate("2026-05-24");
    expect(d).not.toBeNull();
    expect(d!.getUTCDay()).toBe(0);
  });

  it("rejects a non-Sunday", () => {
    // 2026-05-25 is a Monday
    expect(parseWeekEndingDate("2026-05-25")).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(parseWeekEndingDate("not-a-date")).toBeNull();
    expect(parseWeekEndingDate("2026-13-01")).toBeNull();
    expect(parseWeekEndingDate("2026-02-30")).toBeNull();
    expect(parseWeekEndingDate("'; DROP TABLE")).toBeNull();
    expect(parseWeekEndingDate("")).toBeNull();
  });
});

describe("weekEndingSunday", () => {
  it("returns the same date for a Sunday", () => {
    expect(weekEndingSunday(new Date("2026-05-24T00:00:00Z"))).toBe("2026-05-24");
  });

  it("returns previous Sunday for a Wednesday", () => {
    // 2026-05-20 is a Wednesday → previous Sunday is 2026-05-17
    expect(weekEndingSunday(new Date("2026-05-20T12:00:00Z"))).toBe("2026-05-17");
  });

  it("returns previous Sunday for a Saturday", () => {
    // 2026-05-23 is a Saturday → previous Sunday is 2026-05-17
    expect(weekEndingSunday(new Date("2026-05-23T23:59:59Z"))).toBe("2026-05-17");
  });
});

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

function makeProviderResponses(
  anthropicFindings: Array<{ category: string }>,
  openaiFindings: Array<{ category: string }>,
  anthropicMs = 5000,
  openaiMs = 3000,
) {
  return {
    perProvider: [
      {
        name: "anthropic",
        ms: anthropicMs,
        error: null,
        output: {
          findings: anthropicFindings.map((f) => ({
            title: "test",
            category: f.category,
            severity: "medium",
            confidence: "high",
            evidence: [],
            reasoning: "test",
            recommendation: "test",
          })),
        },
      },
      {
        name: "openai",
        ms: openaiMs,
        error: null,
        output: {
          findings: openaiFindings.map((f) => ({
            title: "test",
            category: f.category,
            severity: "medium",
            confidence: "high",
            evidence: [],
            reasoning: "test",
            recommendation: "test",
          })),
        },
      },
    ],
  };
}

describe("aggregatePayload", () => {
  const weekStart = new Date("2026-05-18T00:00:00Z"); // Monday
  const weekEnd = new Date("2026-05-24T00:00:00Z"); // Sunday

  it("returns zero stats for empty data", () => {
    const result = aggregatePayload([], [], weekStart, weekEnd);
    expect(result.sample.reviewsAnalyzed).toBe(0);
    expect(result.sample.findingsPosted).toBe(0);
    expect(result.perProvider.anthropic.avgFindingsPerPR).toBe(0);
    expect(result.perProvider.openai.avgFindingsPerPR).toBe(0);
    expect(result.agreement.rate).toBe(0);
  });

  it("aggregates two reviews correctly", () => {
    const reviewRows = [
      {
        reviewId: "r1",
        providerResponses: makeProviderResponses(
          [{ category: "api-contract" }, { category: "security" }],
          [{ category: "api-contract" }],
          6000,
          4000,
        ),
        costEstimatedUsd: "0.50",
      },
      {
        reviewId: "r2",
        providerResponses: makeProviderResponses(
          [{ category: "security" }],
          [{ category: "security" }, { category: "performance" }],
          8000,
          2000,
        ),
        costEstimatedUsd: "0.40",
      },
    ];

    const findingRows = [
      { reviewId: "r1", suggestedPatchOpus: "patch1", suggestedPatchGpt5: "patch2" },
      { reviewId: "r1", suggestedPatchOpus: "patch3", suggestedPatchGpt5: null },
      { reviewId: "r2", suggestedPatchOpus: null, suggestedPatchGpt5: "patch4" },
    ];

    const result = aggregatePayload(reviewRows, findingRows, weekStart, weekEnd);

    expect(result.weekStart).toBe("2026-05-18");
    expect(result.weekEnd).toBe("2026-05-24");
    expect(result.sample.reviewsAnalyzed).toBe(2);
    expect(result.sample.findingsPosted).toBe(3);
    expect(result.sample.publicReceiptOnly).toBe(true);

    // Anthropic: 3 findings over 2 reviews = 1.5/PR
    expect(result.perProvider.anthropic.avgFindingsPerPR).toBe(1.5);
    // OpenAI: 3 findings over 2 reviews = 1.5/PR
    expect(result.perProvider.openai.avgFindingsPerPR).toBe(1.5);

    // Median wall time: anthropic [6, 8] → median 7s; openai [4, 2] → sorted [2, 4] → median 3s
    expect(result.perProvider.anthropic.medianWallTimeSeconds).toBe(7);
    expect(result.perProvider.openai.medianWallTimeSeconds).toBe(3);

    // Avg cost: (0.50 + 0.40) / 2 = 0.45
    expect(result.perProvider.anthropic.avgCostUsd).toBe(0.45);

    // Agreement: bothProposed=1, opusOnly=1, gpt5Only=1
    expect(result.agreement.bothProposedPatches).toBe(1);
    expect(result.agreement.opusOnlyFindings).toBe(1);
    expect(result.agreement.gpt5OnlyFindings).toBe(1);

    // Top categories: anthropic has security(2), api-contract(1)
    expect(result.perProvider.anthropic.topCategories[0]).toEqual({
      category: "security",
      count: 2,
    });
  });

  it("handles reviews with no cost data", () => {
    const reviewRows = [
      {
        reviewId: "r1",
        providerResponses: makeProviderResponses([{ category: "test" }], [], 1000, 2000),
        costEstimatedUsd: "0",
      },
    ];

    const result = aggregatePayload(reviewRows, [], weekStart, weekEnd);
    expect(result.perProvider.anthropic.avgCostUsd).toBeNull();
  });

  it("computes patchProposalRate without division by zero", () => {
    const reviewRows = [
      {
        reviewId: "r1",
        providerResponses: makeProviderResponses(
          [{ category: "test" }],
          [{ category: "test" }],
          1000,
          2000,
        ),
        costEstimatedUsd: "0.50",
      },
    ];
    // No finding_status rows (findingsPosted = 0, but provider findings exist)
    const result = aggregatePayload(reviewRows, [], weekStart, weekEnd);
    expect(result.perProvider.anthropic.patchProposalRate).toBe(0);
    expect(result.perProvider.openai.patchProposalRate).toBe(0);
    expect(Number.isFinite(result.perProvider.anthropic.patchProposalRate)).toBe(true);
    expect(Number.isFinite(result.perProvider.openai.patchProposalRate)).toBe(true);
  });

  it("handles skipped provider responses", () => {
    const reviewRows = [
      {
        reviewId: "r1",
        providerResponses: { status: "skipped" },
        costEstimatedUsd: "0",
      },
    ];

    const result = aggregatePayload(reviewRows, [], weekStart, weekEnd);
    expect(result.perProvider.anthropic.avgFindingsPerPR).toBe(0);
    expect(result.perProvider.anthropic.medianWallTimeSeconds).toBe(0);
  });

  it("handles malformed provider responses gracefully", () => {
    const reviewRows = [
      {
        reviewId: "r1",
        providerResponses: null,
        costEstimatedUsd: "0",
      },
      {
        reviewId: "r2",
        providerResponses: "not-an-object",
        costEstimatedUsd: "0",
      },
    ];

    const result = aggregatePayload(reviewRows, [], weekStart, weekEnd);
    expect(result.sample.reviewsAnalyzed).toBe(2);
    expect(result.perProvider.anthropic.avgFindingsPerPR).toBe(0);
  });
});
