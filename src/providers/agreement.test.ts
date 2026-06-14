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
});
