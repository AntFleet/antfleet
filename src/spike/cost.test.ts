import { describe, it, expect } from "vitest";
import {
  COST_PER_CALL_USD_ESTIMATES,
  DEFAULT_COST_CEILING_USD,
  estimateCallCost,
  estimateRunCost,
  shouldAbortBeforeRun,
} from "./cost.js";

describe("estimateCallCost", () => {
  it("returns the configured estimate for known providers", () => {
    expect(estimateCallCost("anthropic")).toBe(COST_PER_CALL_USD_ESTIMATES["anthropic"]);
    expect(estimateCallCost("openrouter")).toBe(COST_PER_CALL_USD_ESTIMATES["openrouter"]);
    expect(estimateCallCost("codex")).toBe(0);
  });

  it("falls back to a default for unknown providers (not zero)", () => {
    expect(estimateCallCost("brand-new-thing")).toBeGreaterThan(0);
  });
});

describe("estimateRunCost", () => {
  it("returns 0 for an empty provider list", () => {
    expect(estimateRunCost([])).toBe(0);
  });

  it("sums per-provider estimates", () => {
    const sum = estimateRunCost(["anthropic", "openai", "openrouter"]);
    const expected =
      (COST_PER_CALL_USD_ESTIMATES["anthropic"] ?? 0) +
      (COST_PER_CALL_USD_ESTIMATES["openai"] ?? 0) +
      (COST_PER_CALL_USD_ESTIMATES["openrouter"] ?? 0);
    expect(sum).toBeCloseTo(expected, 6);
  });

  it("does not double-count when the same provider appears twice (deliberate; caller responsibility)", () => {
    // estimateRunCost is intentionally a plain sum; callers should dedupe if needed.
    const single = estimateRunCost(["anthropic"]);
    const double = estimateRunCost(["anthropic", "anthropic"]);
    expect(double).toBeCloseTo(single * 2, 6);
  });
});

describe("shouldAbortBeforeRun", () => {
  it("allows runs while cumulative + next stays under the ceiling", () => {
    const decision = shouldAbortBeforeRun(1.0, 0.5, DEFAULT_COST_CEILING_USD);
    expect(decision.abort).toBe(false);
    expect(decision.projectedCost).toBeCloseTo(1.5, 6);
  });

  it("allows runs at exact ceiling (equality is not an abort)", () => {
    const decision = shouldAbortBeforeRun(4.5, 0.5, 5);
    expect(decision.abort).toBe(false);
    expect(decision.projectedCost).toBe(5);
  });

  it("aborts when projected cost would exceed the ceiling", () => {
    const decision = shouldAbortBeforeRun(4.8, 0.3, 5);
    expect(decision.abort).toBe(true);
    expect(decision.projectedCost).toBeCloseTo(5.1, 6);
    expect(decision.reason).toMatch(/ceiling \$5\.00/u);
  });

  it("aborts immediately when cumulative is already at or above ceiling", () => {
    const decision = shouldAbortBeforeRun(5.0, 0.01, 5);
    expect(decision.abort).toBe(true);
  });

  it("honors a custom (lower) ceiling for tight budgets", () => {
    const decision = shouldAbortBeforeRun(0.8, 0.3, 1);
    expect(decision.abort).toBe(true);
    expect(decision.reason).toMatch(/\$1\.10.*ceiling \$1\.00/u);
  });
});
