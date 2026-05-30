import { describe, it, expect } from "vitest";
import {
  reconcileReviewCostUsd,
  runPatchCostReconcile,
  type ReconcileFindingRow,
  type ReconcileDeps,
} from "./patch-cost-reconcile";

const measured = (over: Partial<ReconcileFindingRow> = {}): ReconcileFindingRow => ({
  inputTokensOpus: 1000,
  outputTokensOpus: 1000,
  inputTokensGpt5: 1000,
  outputTokensGpt5: 1000,
  ...over,
});

const unmeasured: ReconcileFindingRow = {
  inputTokensOpus: null,
  outputTokensOpus: null,
  inputTokensGpt5: null,
  outputTokensGpt5: null,
};

describe("reconcileReviewCostUsd", () => {
  it("prices a fully measured finding from its real token columns", () => {
    // opus 0.09 + gpt5 0.035 = 0.125
    expect(reconcileReviewCostUsd([measured()])).toBe(0.125);
  });

  it("falls back to the documented heuristic when a finding is entirely unmeasured", () => {
    // opus heuristic {2000,500} = 0.0675; gpt5 heuristic {2000,500} = 0.025 → 0.0925
    expect(reconcileReviewCostUsd([unmeasured])).toBe(0.0925);
  });

  it("prices only the measured side when one provider's tokens are present", () => {
    // opus measured (0.09); gpt5 columns null but the row counts as measured,
    // so gpt5 is priced as a $0 no-call rather than heuristic-backfilled.
    const partial = measured({ inputTokensGpt5: null, outputTokensGpt5: null });
    expect(reconcileReviewCostUsd([partial])).toBe(0.09);
  });

  it("sums across multiple findings in a review", () => {
    // 0.125 + 0.0925 = 0.2175
    expect(reconcileReviewCostUsd([measured(), unmeasured])).toBe(0.2175);
  });
});

describe("runPatchCostReconcile", () => {
  it("writes a cost for every candidate review and reports a summary", async () => {
    const writes: Array<{ reviewId: string; cost: number }> = [];
    const deps: ReconcileDeps = {
      loadCandidates: async () =>
        new Map<string, ReconcileFindingRow[]>([
          ["rev-measured", [measured()]],
          ["rev-unmeasured", [unmeasured]],
        ]),
      writeReviewCost: async (reviewId, cost) => {
        writes.push({ reviewId, cost });
      },
      now: () => new Date("2026-05-30T00:00:00Z"),
    };

    const summary = await runPatchCostReconcile(deps);

    expect(summary.reviewsScanned).toBe(2);
    expect(summary.reviewsUpdated).toBe(2);
    expect(summary.totalEstimatedUsd).toBe(0.2175); // 0.125 + 0.0925
    expect(summary.averagePerReviewUsd).toBe(0.1088); // 0.2175 / 2 → rounded
    expect(writes).toContainEqual({ reviewId: "rev-measured", cost: 0.125 });
    expect(writes).toContainEqual({ reviewId: "rev-unmeasured", cost: 0.0925 });
  });

  it("is a no-op with a zeroed summary when there are no candidates", async () => {
    const deps: ReconcileDeps = {
      loadCandidates: async () => new Map(),
      writeReviewCost: async () => {
        throw new Error("should not write when there are no candidates");
      },
      now: () => new Date("2026-05-30T00:00:00Z"),
    };
    const summary = await runPatchCostReconcile(deps);
    expect(summary).toEqual({
      reviewsScanned: 0,
      reviewsUpdated: 0,
      totalEstimatedUsd: 0,
      averagePerReviewUsd: 0,
    });
  });
});
