import { describe, it, expect } from "vitest";
import type { ReviewOutput } from "../types.js";
import {
  AgreementMode,
  Finding,
  ProviderReview,
  findingsAgree,
  mergeFindings,
} from "./agreement.js";

type FindingOverrides = Partial<Omit<Finding, "evidence">> & {
  evidence?: Finding["evidence"];
};

function makeFinding(overrides: FindingOverrides = {}): Finding {
  return {
    title: "Null deref in handler",
    category: "bug",
    severity: "high",
    label: "blocking",
    confidence: "high",
    evidence: [
      {
        path: "src/handler.ts",
        startLine: 10,
        endLine: 20,
        symbol: null,
        quote: null,
      },
    ],
    reasoning: "test reasoning",
    reproduction: null,
    recommendation: "test rec",
    whyTestsDoNotAlreadyCoverThis: "no test",
    suggestedRegressionTest: null,
    minimumFixScope: "narrow",
    requiresPolicyReview: false,
    upstreamOrigin: null,
    ...overrides,
  };
}

function review(providerName: string, findings: Finding[]): ProviderReview {
  const output: ReviewOutput = {
    findings,
    inspected: { files: [], symbols: [], notes: [] },
  };
  return { providerName, output };
}

function run(
  mode: AgreementMode,
  providers: ProviderReview[],
): { agreedCount: number; disagreementCount: number; result: ReturnType<typeof mergeFindings> } {
  const result = mergeFindings(providers, mode);
  return {
    agreedCount: result.agreed.length,
    disagreementCount: result.disagreements.length,
    result,
  };
}

describe("findingsAgree", () => {
  it("agrees when category, evidence, and severity match exactly", () => {
    const a = makeFinding();
    const b = makeFinding();
    expect(findingsAgree(a, b)).toBe(true);
  });

  it("disagrees when categories differ", () => {
    const a = makeFinding({ category: "bug" });
    const b = makeFinding({ category: "security" });
    expect(findingsAgree(a, b)).toBe(false);
  });

  it("agrees when severities are within 1 bucket (high vs medium)", () => {
    const a = makeFinding({ severity: "high" });
    const b = makeFinding({ severity: "medium" });
    expect(findingsAgree(a, b)).toBe(true);
  });

  it("disagrees when severities differ by more than 1 bucket (critical vs medium)", () => {
    const a = makeFinding({ severity: "critical" });
    const b = makeFinding({ severity: "medium" });
    expect(findingsAgree(a, b)).toBe(false);
  });

  it("agrees on overlapping line ranges even when wording differs", () => {
    const a = makeFinding({
      title: "Possible null dereference",
      evidence: [{ path: "src/handler.ts", startLine: 10, endLine: 20, symbol: null, quote: null }],
    });
    const b = makeFinding({
      title: "TypeError: cannot read of null",
      evidence: [{ path: "src/handler.ts", startLine: 15, endLine: 25, symbol: null, quote: null }],
    });
    expect(findingsAgree(a, b)).toBe(true);
  });

  it("disagrees when paths differ even with same line range", () => {
    const a = makeFinding({
      evidence: [{ path: "src/handler.ts", startLine: 10, endLine: 20, symbol: null, quote: null }],
    });
    const b = makeFinding({
      evidence: [{ path: "src/other.ts", startLine: 10, endLine: 20, symbol: null, quote: null }],
    });
    expect(findingsAgree(a, b)).toBe(false);
  });

  it("disagrees on disjoint line ranges in the same file", () => {
    const a = makeFinding({
      evidence: [{ path: "src/handler.ts", startLine: 10, endLine: 20, symbol: null, quote: null }],
    });
    const b = makeFinding({
      evidence: [{ path: "src/handler.ts", startLine: 30, endLine: 40, symbol: null, quote: null }],
    });
    expect(findingsAgree(a, b)).toBe(false);
  });

  // Sparse-evidence fallback (added for GPT-5 reasoning-model interop).
  // When one provider returns a finding with only a file path — no line range,
  // no symbol, no quote — and the other side localized the same file, we
  // accept the path-level match. The upstream category + severity gates still
  // apply.
  it("treats a fully path-only finding as a path-level wildcard against a localized counterpart", () => {
    const sparse = makeFinding({
      evidence: [
        { path: "src/handler.ts", startLine: null, endLine: null, symbol: null, quote: null },
      ],
    });
    const localized = makeFinding({
      evidence: [
        { path: "src/handler.ts", startLine: 100, endLine: 200, symbol: null, quote: null },
      ],
    });
    expect(findingsAgree(sparse, localized)).toBe(true);
  });

  it("sparse-evidence fallback still requires category to match", () => {
    const sparse = makeFinding({
      category: "bug",
      evidence: [
        { path: "src/handler.ts", startLine: null, endLine: null, symbol: null, quote: null },
      ],
    });
    const localizedDifferentCategory = makeFinding({
      category: "security",
      evidence: [
        { path: "src/handler.ts", startLine: 100, endLine: 200, symbol: null, quote: null },
      ],
    });
    expect(findingsAgree(sparse, localizedDifferentCategory)).toBe(false);
  });

  it("sparse-evidence fallback still requires severities within 1 bucket", () => {
    const sparse = makeFinding({
      severity: "critical",
      evidence: [
        { path: "src/handler.ts", startLine: null, endLine: null, symbol: null, quote: null },
      ],
    });
    const localizedFarSeverity = makeFinding({
      severity: "low",
      evidence: [
        { path: "src/handler.ts", startLine: 100, endLine: 200, symbol: null, quote: null },
      ],
    });
    expect(findingsAgree(sparse, localizedFarSeverity)).toBe(false);
  });

  it("sparse-evidence fallback requires the file paths to actually match", () => {
    const sparse = makeFinding({
      evidence: [
        { path: "src/handler.ts", startLine: null, endLine: null, symbol: null, quote: null },
      ],
    });
    const localizedOtherFile = makeFinding({
      evidence: [{ path: "src/other.ts", startLine: 100, endLine: 200, symbol: null, quote: null }],
    });
    expect(findingsAgree(sparse, localizedOtherFile)).toBe(false);
  });

  it("agrees on null line ranges when both providers name the same symbol", () => {
    const a = makeFinding({
      evidence: [
        {
          path: "src/handler.ts",
          startLine: null,
          endLine: null,
          symbol: "handleRequest",
          quote: null,
        },
      ],
    });
    const b = makeFinding({
      evidence: [
        {
          path: "src/handler.ts",
          startLine: 100,
          endLine: 200,
          symbol: "handleRequest",
          quote: null,
        },
      ],
    });
    expect(findingsAgree(a, b)).toBe(true);
  });

  it("normalizes leading ./ in evidence paths before comparing", () => {
    const a = makeFinding({
      evidence: [
        { path: "./src/handler.ts", startLine: 10, endLine: 20, symbol: null, quote: null },
      ],
    });
    const b = makeFinding({
      evidence: [{ path: "src/handler.ts", startLine: 10, endLine: 20, symbol: null, quote: null }],
    });
    expect(findingsAgree(a, b)).toBe(true);
  });

  it("agrees if any one evidence pair across multi-evidence findings overlaps", () => {
    const a = makeFinding({
      evidence: [
        { path: "src/a.ts", startLine: 1, endLine: 5, symbol: null, quote: null },
        { path: "src/b.ts", startLine: 50, endLine: 60, symbol: null, quote: null },
      ],
    });
    const b = makeFinding({
      evidence: [
        { path: "src/c.ts", startLine: 1, endLine: 5, symbol: null, quote: null },
        { path: "src/b.ts", startLine: 55, endLine: 65, symbol: null, quote: null },
      ],
    });
    expect(findingsAgree(a, b)).toBe(true);
  });

  it("returns false when neither finding has any evidence rows", () => {
    const a = makeFinding({ evidence: [] });
    const b = makeFinding({ evidence: [] });
    expect(findingsAgree(a, b)).toBe(false);
  });

  // LINE_OVERLAP_SLACK tests — widened line-overlap window (±5)
  it("agrees when line ranges have a gap of exactly 5 (boundary)", () => {
    // a: 10–20, b: 26–30  → gap = 26 − 20 = 6... wait, need gap ≤ 5
    // a: 10–20, b: 25–30  → gap = 25 − 20 − 1 = 4 (adjacent gap = bS − aE − 1 = 4)
    // Strict gap = bS − aE = 5, meaning bS = aE + 5. Should merge.
    const a = makeFinding({
      evidence: [{ path: "src/handler.ts", startLine: 10, endLine: 20, symbol: null, quote: null }],
    });
    const b = makeFinding({
      evidence: [{ path: "src/handler.ts", startLine: 25, endLine: 30, symbol: null, quote: null }],
    });
    // gap = bS − aE = 25 − 20 = 5; should merge with slack=5
    expect(findingsAgree(a, b)).toBe(true);
  });

  it("disagrees when line ranges have a gap greater than 5", () => {
    const a = makeFinding({
      evidence: [{ path: "src/handler.ts", startLine: 10, endLine: 20, symbol: null, quote: null }],
    });
    const b = makeFinding({
      evidence: [{ path: "src/handler.ts", startLine: 27, endLine: 35, symbol: null, quote: null }],
    });
    // gap = bS − aE = 27 − 20 = 7; exceeds slack=5, should not merge
    expect(findingsAgree(a, b)).toBe(false);
  });

  it("existing disjoint-range test (gap=10) still disagrees after slack change", () => {
    // Mirrors the original "disagrees on disjoint line ranges" test at line ~110
    const a = makeFinding({
      evidence: [{ path: "src/handler.ts", startLine: 10, endLine: 20, symbol: null, quote: null }],
    });
    const b = makeFinding({
      evidence: [{ path: "src/handler.ts", startLine: 30, endLine: 40, symbol: null, quote: null }],
    });
    // gap = bS − aE = 30 − 20 = 10; exceeds slack=5
    expect(findingsAgree(a, b)).toBe(false);
  });

  it("slack requires same category — different categories do not agree even with close lines", () => {
    const a = makeFinding({
      category: "bug",
      evidence: [{ path: "src/handler.ts", startLine: 10, endLine: 20, symbol: null, quote: null }],
    });
    const b = makeFinding({
      category: "security",
      evidence: [{ path: "src/handler.ts", startLine: 22, endLine: 30, symbol: null, quote: null }],
    });
    expect(findingsAgree(a, b)).toBe(false);
  });

  it("slack requires severity within 1 bucket — gap≤5 does not override severity gate", () => {
    const a = makeFinding({
      severity: "critical",
      evidence: [{ path: "src/handler.ts", startLine: 10, endLine: 20, symbol: null, quote: null }],
    });
    const b = makeFinding({
      severity: "low",
      evidence: [{ path: "src/handler.ts", startLine: 22, endLine: 30, symbol: null, quote: null }],
    });
    expect(findingsAgree(a, b)).toBe(false);
  });

  it("slack requires same path — near-adjacent lines on different files do not agree", () => {
    const a = makeFinding({
      evidence: [{ path: "src/handler.ts", startLine: 10, endLine: 20, symbol: null, quote: null }],
    });
    const b = makeFinding({
      evidence: [{ path: "src/other.ts", startLine: 22, endLine: 30, symbol: null, quote: null }],
    });
    expect(findingsAgree(a, b)).toBe(false);
  });

  it("null-line path unchanged: both-null falls through to symbol/path-only branch (not spurious line match)", () => {
    // Two findings with both sides null — lineRangesOverlap short-circuits false;
    // they can still agree via symbol match
    const a = makeFinding({
      evidence: [
        { path: "src/handler.ts", startLine: null, endLine: null, symbol: "doThing", quote: null },
      ],
    });
    const b = makeFinding({
      evidence: [
        { path: "src/handler.ts", startLine: null, endLine: null, symbol: "doThing", quote: null },
      ],
    });
    expect(findingsAgree(a, b)).toBe(true);
  });

  it("null-line path unchanged: disjoint-localized pair does not spuriously match via null short-circuit", () => {
    // One side is fully null, other side is far-away line range; should still agree
    // via path-only fallback (isPathOnly), not produce a spurious line match
    const sparse = makeFinding({
      evidence: [
        { path: "src/handler.ts", startLine: null, endLine: null, symbol: null, quote: null },
      ],
    });
    const localized = makeFinding({
      evidence: [
        { path: "src/handler.ts", startLine: 300, endLine: 400, symbol: null, quote: null },
      ],
    });
    // path-only fallback still applies — this should agree
    expect(findingsAgree(sparse, localized)).toBe(true);
  });

  it("half-null point range is widened by slack (only startLine present)", () => {
    // a has only startLine; b is 5 lines away — should merge with slack
    const a = makeFinding({
      evidence: [
        { path: "src/handler.ts", startLine: 20, endLine: null, symbol: null, quote: null },
      ],
    });
    const b = makeFinding({
      evidence: [{ path: "src/handler.ts", startLine: 25, endLine: 30, symbol: null, quote: null }],
    });
    // aS=20 aE=20 (null→aStart), bS=25 bE=30: bS − aE = 5 ≤ slack → merge
    expect(findingsAgree(a, b)).toBe(true);
  });

  it("half-null point range beyond slack does not merge", () => {
    const a = makeFinding({
      evidence: [
        { path: "src/handler.ts", startLine: 20, endLine: null, symbol: null, quote: null },
      ],
    });
    const b = makeFinding({
      evidence: [{ path: "src/handler.ts", startLine: 27, endLine: 35, symbol: null, quote: null }],
    });
    // gap = 27 − 20 = 7 > 5
    expect(findingsAgree(a, b)).toBe(false);
  });

  // ── H1 / M1 distinctness guard ──────────────────────────────────────────────
  // Weak overlaps (a fully path-only wildcard, or line ranges within slack that do
  // NOT actually intersect) must be corroborated by title/reasoning similarity
  // before they count as agreement — otherwise one model's path-only finding can
  // fabricate a "both models agreed" receipt against an unrelated localized finding.

  it("H1: a path-only finding does NOT agree with a DISSIMILAR localized finding on the same file", () => {
    const sparse = makeFinding({
      title: "Race condition on the shared session cache",
      reasoning:
        "two request handlers mutate the in-memory session map concurrently without a lock",
      evidence: [{ path: "src/x.ts", startLine: null, endLine: null, symbol: null, quote: null }],
    });
    const localized = makeFinding({
      title: "Unvalidated email address reaches the SQL query",
      reasoning: "the email string is interpolated into a raw query with no sanitization",
      evidence: [{ path: "src/x.ts", startLine: 100, endLine: 200, symbol: null, quote: null }],
    });
    expect(findingsAgree(sparse, localized)).toBe(false);
  });

  it("recall preserved: a path-only finding DOES agree with a SIMILAR localized finding (mergeSettings case)", () => {
    const sparse = makeFinding({
      title: "Data loss in mergeSettings",
      reasoning:
        "mergeSettings overwrites nested user config keys instead of deep-merging, so nested settings data is dropped on save",
      evidence: [
        { path: "src/settings.ts", startLine: null, endLine: null, symbol: null, quote: null },
      ],
    });
    const localized = makeFinding({
      category: "data-loss",
      title: "mergeSettings clobbers nested config",
      reasoning:
        "mergeSettings does a shallow overwrite so nested user config keys are lost; nested settings data dropped on save",
      evidence: [
        { path: "src/settings.ts", startLine: 40, endLine: 60, symbol: null, quote: null },
      ],
    });
    // same category so the category gate passes; both about mergeSettings losing nested config
    const sparseDataLoss = makeFinding({
      ...sparse,
      category: "data-loss",
    });
    expect(findingsAgree(sparseDataLoss, localized)).toBe(true);
  });

  it("M1: near-adjacent (gap≤5) but DISSIMILAR findings do NOT agree", () => {
    const a = makeFinding({
      title: "Off-by-one in the pagination cursor",
      reasoning: "the cursor skips the last row because the boundary uses < instead of <=",
      evidence: [{ path: "src/page.ts", startLine: 10, endLine: 20, symbol: null, quote: null }],
    });
    const b = makeFinding({
      title: "Unclosed file handle leaks a descriptor",
      reasoning: "the read stream is never closed on the error path so descriptors leak",
      evidence: [{ path: "src/page.ts", startLine: 22, endLine: 30, symbol: null, quote: null }],
    });
    // gap = 22 − 20 = 2 ≤ slack, but the two findings are unrelated
    expect(findingsAgree(a, b)).toBe(false);
  });

  it("recall preserved: near-adjacent (gap≤5) SIMILAR findings still agree", () => {
    const a = makeFinding({
      title: "Null dereference in the request handler",
      reasoning: "handler dereferences req.user before the null guard runs",
      evidence: [{ path: "src/handler.ts", startLine: 10, endLine: 20, symbol: null, quote: null }],
    });
    const b = makeFinding({
      title: "Null dereference on req.user in handler",
      reasoning: "the handler reads req.user null field before guarding against null",
      evidence: [{ path: "src/handler.ts", startLine: 23, endLine: 30, symbol: null, quote: null }],
    });
    expect(findingsAgree(a, b)).toBe(true);
  });

  it("strong anchors are unaffected: real line intersection agrees even when wording is dissimilar", () => {
    const a = makeFinding({
      title: "Off-by-one in pagination cursor",
      reasoning: "boundary comparison uses < instead of <=",
      evidence: [{ path: "src/x.ts", startLine: 10, endLine: 20, symbol: null, quote: null }],
    });
    const b = makeFinding({
      title: "Descriptor leak on error path",
      reasoning: "stream never closed when the read throws",
      evidence: [{ path: "src/x.ts", startLine: 15, endLine: 25, symbol: null, quote: null }],
    });
    // ranges truly intersect (15–20) → strong → accepted without a similarity check
    expect(findingsAgree(a, b)).toBe(true);
  });

  it("strong anchors are unaffected: same symbol agrees even when wording is dissimilar", () => {
    const a = makeFinding({
      title: "Off-by-one in pagination cursor",
      reasoning: "boundary comparison uses < instead of <=",
      evidence: [
        { path: "src/x.ts", startLine: null, endLine: null, symbol: "paginate", quote: null },
      ],
    });
    const b = makeFinding({
      title: "Descriptor leak on error path",
      reasoning: "stream never closed when the read throws",
      evidence: [
        { path: "src/x.ts", startLine: 999, endLine: 1010, symbol: "paginate", quote: null },
      ],
    });
    expect(findingsAgree(a, b)).toBe(true);
  });

  it("strong anchors are unaffected: same symbol with lines present and gap≤5 stays STRONG (not downgraded to weak)", () => {
    // Regression window for the strong/weak ordering: BOTH sides have line ranges
    // within slack AND share a symbol AND are textually dissimilar. The symbol is a
    // strong anchor and must win — it must not be downgraded to a weak signal and
    // then rejected by the similarity gate.
    const a = makeFinding({
      title: "Off-by-one in the pagination cursor",
      reasoning: "boundary comparison uses < instead of <=",
      evidence: [{ path: "src/x.ts", startLine: 10, endLine: 20, symbol: "paginate", quote: null }],
    });
    const b = makeFinding({
      title: "File descriptor leak on the error path",
      reasoning: "stream never closed when the read throws",
      evidence: [{ path: "src/x.ts", startLine: 23, endLine: 30, symbol: "paginate", quote: null }],
    });
    // gap = 23 − 20 = 3 ≤ slack, dissimilar wording — only the shared symbol links them
    expect(findingsAgree(a, b)).toBe(true);
  });

  it("H1/M1 floor: a two-token finding sharing exactly ONE common token does NOT agree via a weak overlap", () => {
    // Overlap-coefficient alone would give 1/2 = 0.5 and pass; the shared-token floor
    // must reject a single coincidental domain word bridging two distinct findings.
    const sparse = makeFinding({
      title: "Data race",
      reasoning: "",
      evidence: [{ path: "src/x.ts", startLine: null, endLine: null, symbol: null, quote: null }],
    });
    const localized = makeFinding({
      title: "Stale cache serves data",
      reasoning: "the cache never invalidates so old data is returned to the client",
      evidence: [{ path: "src/x.ts", startLine: 100, endLine: 120, symbol: null, quote: null }],
    });
    // only shared meaningful token is "data" → below the 2-token floor
    expect(findingsAgree(sparse, localized)).toBe(false);
  });

  it("H1/M1 floor: near-adjacent findings sharing exactly ONE common token do NOT agree", () => {
    const a = makeFinding({
      title: "Data race",
      reasoning: "",
      evidence: [{ path: "src/x.ts", startLine: 10, endLine: 20, symbol: null, quote: null }],
    });
    const b = makeFinding({
      title: "Cache drops data",
      reasoning: "eviction removes live entries",
      evidence: [{ path: "src/x.ts", startLine: 23, endLine: 30, symbol: null, quote: null }],
    });
    // gap = 3 ≤ slack but only shared token is "data" → below the floor
    expect(findingsAgree(a, b)).toBe(false);
  });

  it("degenerate reversed range is handled without throwing", () => {
    // aStart > aEnd is ill-formed but should not throw
    const a = makeFinding({
      evidence: [{ path: "src/handler.ts", startLine: 20, endLine: 10, symbol: null, quote: null }],
    });
    const b = makeFinding({
      evidence: [{ path: "src/handler.ts", startLine: 15, endLine: 25, symbol: null, quote: null }],
    });
    // No assertion on true/false — just must not throw
    expect(() => findingsAgree(a, b)).not.toThrow();
  });
});

describe("mergeFindings", () => {
  it("returns empty results when given no providers", () => {
    expect(mergeFindings([], "unanimous")).toEqual({ agreed: [], disagreements: [] });
  });

  it("merges identical findings into a single agreed entry (unanimous, N=2)", () => {
    const f = makeFinding();
    const { agreedCount, disagreementCount } = run("unanimous", [
      review("a", [f]),
      review("b", [f]),
    ]);
    expect(agreedCount).toBe(1);
    expect(disagreementCount).toBe(0);
  });

  it("merges 'same bug, different wording' across providers into one agreed entry", () => {
    const a = makeFinding({
      title: "Possible null dereference",
      evidence: [{ path: "src/x.ts", startLine: 10, endLine: 20, symbol: null, quote: null }],
    });
    const b = makeFinding({
      title: "TypeError on null access",
      evidence: [{ path: "src/x.ts", startLine: 15, endLine: 25, symbol: null, quote: null }],
    });
    const { agreedCount, disagreementCount } = run("unanimous", [
      review("a", [a]),
      review("b", [b]),
    ]);
    expect(agreedCount).toBe(1);
    expect(disagreementCount).toBe(0);
  });

  it("produces N disagreements (no agreed) when N providers each find different files (unanimous)", () => {
    const a = makeFinding({
      evidence: [{ path: "src/a.ts", startLine: 1, endLine: 5, symbol: null, quote: null }],
    });
    const b = makeFinding({
      evidence: [{ path: "src/b.ts", startLine: 1, endLine: 5, symbol: null, quote: null }],
    });
    const c = makeFinding({
      evidence: [{ path: "src/c.ts", startLine: 1, endLine: 5, symbol: null, quote: null }],
    });
    const { agreedCount, disagreementCount } = run("unanimous", [
      review("a", [a]),
      review("b", [b]),
      review("c", [c]),
    ]);
    expect(agreedCount).toBe(0);
    expect(disagreementCount).toBe(3);
  });

  it("unanimous requires all N providers (3 of 3 passes)", () => {
    const f = makeFinding();
    const { agreedCount } = run("unanimous", [
      review("a", [f]),
      review("b", [f]),
      review("c", [f]),
    ]);
    expect(agreedCount).toBe(1);
  });

  it("unanimous rejects 2 of 3 (sends to disagreements)", () => {
    const f = makeFinding();
    const { agreedCount, disagreementCount, result } = run("unanimous", [
      review("a", [f]),
      review("b", [f]),
      review("c", []),
    ]);
    expect(agreedCount).toBe(0);
    expect(disagreementCount).toBe(1);
    const [d0] = result.disagreements;
    expect(d0?.providers).toEqual(["a", "b"]);
    expect(d0?.reason).toContain("unanimous mode requires 3");
  });

  it("majority accepts 2 of 3", () => {
    const f = makeFinding();
    const { agreedCount, disagreementCount } = run("majority", [
      review("a", [f]),
      review("b", [f]),
      review("c", []),
    ]);
    expect(agreedCount).toBe(1);
    expect(disagreementCount).toBe(0);
  });

  it("majority rejects 1 of 3", () => {
    const f = makeFinding();
    const { agreedCount, disagreementCount } = run("majority", [
      review("a", [f]),
      review("b", []),
      review("c", []),
    ]);
    expect(agreedCount).toBe(0);
    expect(disagreementCount).toBe(1);
  });

  it("majority over an even N uses strict majority (3 of 4 passes; 2 of 4 fails)", () => {
    const f = makeFinding();
    const passes = run("majority", [
      review("a", [f]),
      review("b", [f]),
      review("c", [f]),
      review("d", []),
    ]);
    expect(passes.agreedCount).toBe(1);
    const fails = run("majority", [
      review("a", [f]),
      review("b", [f]),
      review("c", []),
      review("d", []),
    ]);
    expect(fails.agreedCount).toBe(0);
    expect(fails.disagreementCount).toBe(1);
  });

  it("any accepts a single-provider finding", () => {
    const f = makeFinding();
    const { agreedCount, disagreementCount } = run("any", [
      review("a", [f]),
      review("b", []),
      review("c", []),
    ]);
    expect(agreedCount).toBe(1);
    expect(disagreementCount).toBe(0);
  });

  it("picks the highest-severity representative when providers cluster", () => {
    const low = makeFinding({ severity: "medium", title: "med variant" });
    const high = makeFinding({ severity: "high", title: "high variant" });
    const { result } = run("unanimous", [review("a", [low]), review("b", [high])]);
    expect(result.agreed).toHaveLength(1);
    const [winner] = result.agreed;
    expect(winner?.severity).toBe("high");
  });

  it("does not merge two findings from the same provider into one cluster", () => {
    const a1 = makeFinding({ title: "first" });
    const a2 = makeFinding({ title: "second-identical-to-first" });
    const b = makeFinding({ title: "from b" });
    const { result } = run("any", [review("a", [a1, a2]), review("b", [b])]);
    // a1 and b cluster (different providers, identical evidence). a2 clusters with both via transitivity.
    // Verify all 3 findings collapse to a single cluster because pairwise agreement across providers links them.
    expect(result.agreed).toHaveLength(1);
    expect(result.disagreements).toHaveLength(0);
  });

  it("does not promote a higher-severity transitive endpoint as unanimous consensus", () => {
    const a = makeFinding({
      title: "left endpoint",
      severity: "medium",
      evidence: [{ path: "src/x.ts", startLine: 10, endLine: 15, symbol: null, quote: null }],
    });
    const b = makeFinding({
      title: "bridge finding",
      severity: "medium",
      evidence: [{ path: "src/x.ts", startLine: 14, endLine: 22, symbol: null, quote: null }],
    });
    const c = makeFinding({
      title: "unsupported high endpoint",
      severity: "high",
      evidence: [{ path: "src/x.ts", startLine: 21, endLine: 30, symbol: null, quote: null }],
    });
    expect(findingsAgree(a, b)).toBe(true);
    expect(findingsAgree(b, c)).toBe(true);
    expect(findingsAgree(a, c)).toBe(false);

    const { agreedCount, disagreementCount, result } = run("unanimous", [
      review("a", [a]),
      review("b", [b]),
      review("c", [c]),
    ]);
    expect(agreedCount).toBe(1);
    expect(disagreementCount).toBe(0);
    expect(result.agreed[0]?.title).toBe("bridge finding");
  });

  it("disagreement entries record the providers that flagged the rejected finding", () => {
    const f = makeFinding();
    const { result } = run("unanimous", [
      review("anthropic", [f]),
      review("openai", [f]),
      review("codex", []),
    ]);
    expect(result.disagreements).toHaveLength(1);
    const [d0] = result.disagreements;
    expect(d0?.providers).toEqual(["anthropic", "openai"]);
    expect(d0?.reason).toContain("anthropic, openai");
  });

  it("returns no agreement when no provider produced any findings", () => {
    const { agreedCount, disagreementCount } = run("unanimous", [
      review("a", []),
      review("b", []),
      review("c", []),
    ]);
    expect(agreedCount).toBe(0);
    expect(disagreementCount).toBe(0);
  });

  it("keeps single-provider findings as singleton clusters under unanimous (each becomes its own disagreement)", () => {
    const f1 = makeFinding({
      evidence: [{ path: "src/one.ts", startLine: 1, endLine: 5, symbol: null, quote: null }],
    });
    const f2 = makeFinding({
      evidence: [{ path: "src/two.ts", startLine: 1, endLine: 5, symbol: null, quote: null }],
    });
    const { agreedCount, disagreementCount } = run("unanimous", [
      review("a", [f1]),
      review("b", [f2]),
    ]);
    expect(agreedCount).toBe(0);
    expect(disagreementCount).toBe(2);
  });

  // LINE_OVERLAP_SLACK end-to-end: near-adjacent same-bug merges in mergeFindings
  it("near-adjacent same-bug findings (gap=3) collapse to one agreed entry, zero disagreements", () => {
    const a = makeFinding({
      title: "Null dereference in handler",
      evidence: [{ path: "src/handler.ts", startLine: 10, endLine: 20, symbol: null, quote: null }],
    });
    const b = makeFinding({
      title: "NPE in handler",
      evidence: [{ path: "src/handler.ts", startLine: 23, endLine: 30, symbol: null, quote: null }],
    });
    // gap = bS − aE = 23 − 20 = 3 ≤ slack=5 → should merge
    const { agreedCount, disagreementCount } = run("unanimous", [
      review("anthropic", [a]),
      review("openai", [b]),
    ]);
    expect(agreedCount).toBe(1);
    expect(disagreementCount).toBe(0);
  });

  it("near-adjacent same-bug at boundary gap=5 collapses to one agreed entry", () => {
    const a = makeFinding({
      title: "Unsafe cast",
      evidence: [{ path: "src/cast.ts", startLine: 5, endLine: 10, symbol: null, quote: null }],
    });
    const b = makeFinding({
      title: "Type assertion hazard",
      evidence: [{ path: "src/cast.ts", startLine: 15, endLine: 20, symbol: null, quote: null }],
    });
    // gap = 15 − 10 = 5 = slack → should merge
    const { agreedCount, disagreementCount } = run("unanimous", [
      review("anthropic", [a]),
      review("openai", [b]),
    ]);
    expect(agreedCount).toBe(1);
    expect(disagreementCount).toBe(0);
  });

  // ── H1 end-to-end: false-receipt and swallowed-finding prevention ───────────

  it("H1: a path-only finding dissimilar to a lone localized finding produces NO consensus (no false receipt)", () => {
    const localized = makeFinding({
      title: "Unvalidated email reaches the SQL query",
      reasoning: "email string interpolated into a raw query without sanitization",
      evidence: [{ path: "src/x.ts", startLine: 100, endLine: 120, symbol: null, quote: null }],
    });
    const sparse = makeFinding({
      title: "Race condition on the shared cache",
      reasoning: "two handlers mutate the in-memory map concurrently without a lock",
      evidence: [{ path: "src/x.ts", startLine: null, endLine: null, symbol: null, quote: null }],
    });
    const { agreedCount, disagreementCount } = run("unanimous", [
      review("anthropic", [localized]),
      review("openai", [sparse]),
    ]);
    // pre-fix these wildcard-merged into one false "both agreed" receipt
    expect(agreedCount).toBe(0);
    expect(disagreementCount).toBe(2);
  });

  it("H1: one path-only finding does NOT collapse two DISTINCT localized findings — the unmatched one is surfaced, not swallowed", () => {
    const sqlInjection = makeFinding({
      title: "SQL injection in the search endpoint",
      reasoning: "user query text is concatenated into a raw SQL string with no escaping",
      evidence: [{ path: "src/x.ts", startLine: 10, endLine: 20, symbol: null, quote: null }],
    });
    const nullDeref = makeFinding({
      title: "Null dereference when config is absent",
      reasoning: "config.timeout is read before checking config for null",
      evidence: [{ path: "src/x.ts", startLine: 100, endLine: 110, symbol: null, quote: null }],
    });
    const sparseSqlOnly = makeFinding({
      title: "SQL injection risk in search",
      reasoning: "the search query interpolates user text into raw SQL without escaping",
      evidence: [{ path: "src/x.ts", startLine: null, endLine: null, symbol: null, quote: null }],
    });
    const { result } = run("unanimous", [
      review("anthropic", [sqlInjection, nullDeref]),
      review("openai", [sparseSqlOnly]),
    ]);
    // The sparse SQL finding corroborates ONLY the SQL-injection finding.
    // The null-deref finding must NOT be swallowed into that cluster — it has no
    // second-provider support, so it belongs in disagreements.
    expect(result.agreed).toHaveLength(1);
    expect(result.agreed[0]?.title).toContain("SQL injection");
    expect(result.disagreements).toHaveLength(1);
    expect(result.disagreements[0]?.finding.title).toContain("Null dereference");
  });

  it("gap=6 stays disjoint even in mergeFindings end-to-end", () => {
    const a = makeFinding({
      title: "Bug alpha",
      evidence: [{ path: "src/cast.ts", startLine: 5, endLine: 10, symbol: null, quote: null }],
    });
    const b = makeFinding({
      title: "Bug beta",
      evidence: [{ path: "src/cast.ts", startLine: 16, endLine: 20, symbol: null, quote: null }],
    });
    // gap = 16 − 10 = 6 > 5 → should not merge
    const { agreedCount, disagreementCount } = run("unanimous", [
      review("anthropic", [a]),
      review("openai", [b]),
    ]);
    expect(agreedCount).toBe(0);
    expect(disagreementCount).toBe(2);
  });
});
