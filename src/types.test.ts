import { describe, it, expect } from "vitest";
import { reviewOutputSchema } from "./types.js";

// Minimal valid finding with the new fields omitted, to exercise the
// optional/default backward-compat path and the policy-review severity clamp.
function rawFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Example",
    category: "bug",
    severity: "critical",
    confidence: "high",
    evidence: [{ path: "src/x.ts", startLine: 1, endLine: 1, symbol: null, quote: null }],
    reasoning: "r",
    reproduction: null,
    recommendation: "fix it",
    whyTestsDoNotAlreadyCoverThis: "",
    suggestedRegressionTest: null,
    minimumFixScope: "",
    ...overrides,
  };
}

function parseOne(finding: Record<string, unknown>) {
  const parsed = reviewOutputSchema.parse({
    findings: [finding],
    inspected: { files: [], symbols: [], notes: [] },
  });
  return parsed.findings[0];
}

describe("reviewOutputSchema new fields", () => {
  it("defaults requiresPolicyReview to false and upstreamOrigin to null when omitted", () => {
    const f = parseOne(rawFinding());
    expect(f?.requiresPolicyReview).toBe(false);
    expect(f?.upstreamOrigin).toBeNull();
  });

  it("preserves an explicit upstreamOrigin object", () => {
    const f = parseOne(rawFinding({ upstreamOrigin: { package: "left-pad", reason: "off-by-one" } }));
    expect(f?.upstreamOrigin).toEqual({ package: "left-pad", reason: "off-by-one" });
  });
});

describe("reviewOutputSchema policy-review severity clamp", () => {
  it("clamps critical to medium when requiresPolicyReview is true", () => {
    const f = parseOne(rawFinding({ severity: "critical", requiresPolicyReview: true }));
    expect(f?.severity).toBe("medium");
    expect(f?.requiresPolicyReview).toBe(true);
  });

  it("clamps high to medium when requiresPolicyReview is true", () => {
    const f = parseOne(rawFinding({ severity: "high", requiresPolicyReview: true }));
    expect(f?.severity).toBe("medium");
  });

  it("leaves low/medium untouched (never raises severity) when flagged", () => {
    expect(parseOne(rawFinding({ severity: "low", requiresPolicyReview: true }))?.severity).toBe(
      "low",
    );
    expect(parseOne(rawFinding({ severity: "medium", requiresPolicyReview: true }))?.severity).toBe(
      "medium",
    );
  });

  it("leaves critical/high untouched when requiresPolicyReview is false", () => {
    expect(parseOne(rawFinding({ severity: "critical" }))?.severity).toBe("critical");
    expect(parseOne(rawFinding({ severity: "high", requiresPolicyReview: false }))?.severity).toBe(
      "high",
    );
  });
});
