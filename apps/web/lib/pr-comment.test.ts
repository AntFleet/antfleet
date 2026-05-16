import { describe, expect, it } from "vitest";
import { formatPRComment, type ReviewMeta } from "./pr-comment";
import type { Finding } from "./review-types";

const META: ReviewMeta = {
  reviewId: "abcd1234-ef56-7890-abcd-ef1234567890",
  totalMs: 87000,
  estimatedCostUsd: 0.4,
  modelIds: { anthropic: "claude-opus-4-7", openai: "gpt-5" },
};

const mkFinding = (overrides: Partial<Finding> = {}): Finding => ({
  title: "Title",
  category: "bug",
  severity: "medium",
  confidence: "high",
  evidence: [
    { path: "src/foo.ts", startLine: 10, endLine: 20, symbol: null, quote: null },
  ],
  reasoning: "Reasoning text",
  reproduction: null,
  recommendation: "Recommendation text",
  whyTestsDoNotAlreadyCoverThis: "",
  suggestedRegressionTest: null,
  minimumFixScope: "",
  ...overrides,
});

describe("formatPRComment", () => {
  it("returns empty string when no findings", () => {
    expect(formatPRComment([], META)).toBe("");
  });

  it("includes title, file:line, reasoning, and fix", () => {
    const out = formatPRComment([mkFinding()], META);
    expect(out).toContain("Title");
    expect(out).toContain("`src/foo.ts:10-20`");
    expect(out).toContain("> Reasoning text");
    expect(out).toContain("**Fix:** Recommendation text");
  });

  it("uses singular 'finding' for 1, plural for >1", () => {
    expect(formatPRComment([mkFinding()], META)).toContain("1 finding\n");
    const two = formatPRComment([mkFinding(), mkFinding()], META);
    expect(two).toContain("2 findings\n");
  });

  it("orders findings critical → high → medium → low", () => {
    const out = formatPRComment(
      [
        mkFinding({ severity: "low", title: "LOW" }),
        mkFinding({ severity: "critical", title: "CRIT" }),
        mkFinding({ severity: "medium", title: "MED" }),
        mkFinding({ severity: "high", title: "HIGH" }),
      ],
      META,
    );
    const positions = ["CRIT", "HIGH", "MED", "LOW"].map((t) => out.indexOf(t));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.every((p) => p >= 0)).toBe(true);
  });

  it("title-cases severity and category in the header line", () => {
    const out = formatPRComment([mkFinding({ category: "security", severity: "critical" })], META);
    expect(out).toContain("**Security · Critical**");
  });

  it("renders a single-line file path with no range when startLine === endLine", () => {
    const out = formatPRComment(
      [
        mkFinding({
          evidence: [{ path: "a.ts", startLine: 5, endLine: 5, symbol: null, quote: null }],
        }),
      ],
      META,
    );
    expect(out).toContain("`a.ts:5`");
    expect(out).not.toContain("`a.ts:5-5`");
  });

  it("renders a path-only locator when startLine is null", () => {
    const out = formatPRComment(
      [
        mkFinding({
          evidence: [{ path: "no-lines.ts", startLine: null, endLine: null, symbol: null, quote: null }],
        }),
      ],
      META,
    );
    expect(out).toContain("`no-lines.ts`");
    expect(out).not.toMatch(/no-lines\.ts:/u);
  });

  it("truncates very long reasoning + recommendation with an ellipsis", () => {
    const long = "x".repeat(2000);
    const out = formatPRComment([mkFinding({ reasoning: long, recommendation: long })], META);
    expect(out.length).toBeLessThan(2 * long.length);
    expect(out).toMatch(/…/u);
  });

  it("includes the footer with reviewId prefix, model ids, timing, and cost", () => {
    const out = formatPRComment([mkFinding()], META);
    expect(out).toContain("`abcd1234`");
    expect(out).toContain("`claude-opus-4-7` + `gpt-5`");
    expect(out).toContain("(unanimous)");
    expect(out).toContain("87s");
    expect(out).toContain("~$0.40");
  });
});
