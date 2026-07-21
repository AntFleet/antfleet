import { describe, expect, it, vi } from "vitest";
import type { Finding } from "./review-types";
import {
  BLINDED_PLACEHOLDER,
  candidateKey,
  computeShadowReport,
  redactFindingForBlindedJudge,
  renderShadowReportMarkdown,
  runShadowReplay,
  sampleShadowCandidates,
  type ReviewRowForSampling,
  type ShadowRunRow,
  type StoredRun,
} from "./shadow-judge-replay";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    title: "Allowlist mis-blocks legitimate senders",
    category: "bug",
    severity: "high",
    label: "blocking",
    confidence: "high",
    evidence: [{ path: "src/allow.ts", startLine: 10, endLine: 14, symbol: null, quote: "if (x)" }],
    reasoning: "normalizes entries but compares raw candidates",
    reproduction: null,
    recommendation: "normalize both sides",
    ...over,
  } as Finding;
}

const REVIEW_ID = "11111111-2222-3333-4444-555555555555";

function tierRow(entries: Array<{ provider: string; finding: Finding }>): ReviewRowForSampling {
  return {
    reviewId: REVIEW_ID,
    agreementDecision: { mode: "unanimous", agreed: [], singleModelTier: entries },
    providerResponses: { perProvider: [] },
  };
}

function minedRow(perProvider: Array<{ name: string; findings: Finding[] }>): ReviewRowForSampling {
  return {
    reviewId: REVIEW_ID,
    agreementDecision: { mode: "unanimous", agreed: [] },
    providerResponses: {
      perProvider: perProvider.map((p) => ({ name: p.name, output: { findings: p.findings } })),
    },
  };
}

describe("sampleShadowCandidates", () => {
  it("prefers the persisted single-model tier and carries the full finding", () => {
    const f = finding();
    const rows = [tierRow([{ provider: "anthropic", finding: f }])];
    const out = sampleShadowCandidates(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.origin).toBe("single_model_tier");
    expect(out[0]!.finding.evidence[0]!.quote).toBe("if (x)");
  });

  it("filters to HIGH/CRITICAL by default and honors allSeverities", () => {
    const rows = [
      tierRow([
        { provider: "anthropic", finding: finding({ severity: "medium" } as Partial<Finding>) },
      ]),
    ];
    expect(sampleShadowCandidates(rows)).toHaveLength(0);
    expect(sampleShadowCandidates(rows, { allSeverities: true })).toHaveLength(1);
  });

  it("excludes GLM-flagged entries (self-review guard at the corpus level)", () => {
    const rows = [tierRow([{ provider: "zhipu-glm-5.2", finding: finding() }])];
    expect(sampleShadowCandidates(rows)).toHaveLength(0);
  });

  it("mines solo findings from provider_responses when no tier is persisted", () => {
    const solo = finding({ title: "solo one" } as Partial<Finding>);
    const sharedA = finding({
      title: "shared",
      evidence: [{ path: "src/x.ts", startLine: 5, endLine: 6, symbol: null, quote: null }],
    } as Partial<Finding>);
    const sharedB = finding({
      title: "shared-ish",
      evidence: [{ path: "src/x.ts", startLine: 7, endLine: 8, symbol: null, quote: null }],
    } as Partial<Finding>);
    const rows = [
      minedRow([
        { name: "anthropic", findings: [solo, sharedA] },
        { name: "openai", findings: [sharedB] },
      ]),
    ];
    const out = sampleShadowCandidates(rows);
    // sharedA overlaps sharedB (±5 lines, same path) → not solo. solo has no
    // counterpart → sampled.
    expect(out).toHaveLength(1);
    expect(out[0]!.origin).toBe("mined");
    expect(out[0]!.finding.title).toBe("solo one");
  });

  it("dedups by finding key and respects the limit", () => {
    const f = finding();
    const rows = [
      tierRow([{ provider: "anthropic", finding: f }]),
      tierRow([{ provider: "anthropic", finding: f }]),
    ];
    expect(sampleShadowCandidates(rows)).toHaveLength(1);
    const two = tierRow([
      { provider: "anthropic", finding: finding({ title: "a" } as Partial<Finding>) },
      { provider: "openai", finding: finding({ title: "b" } as Partial<Finding>) },
    ]);
    expect(sampleShadowCandidates([two], { limit: 1 })).toHaveLength(1);
  });
});

describe("redactFindingForBlindedJudge", () => {
  it("withholds prose but keeps the code window and classification", () => {
    const blinded = redactFindingForBlindedJudge(finding());
    expect(blinded.title).toBe(BLINDED_PLACEHOLDER);
    expect(blinded.reasoning).toBe(BLINDED_PLACEHOLDER);
    expect(blinded.recommendation).toBe(BLINDED_PLACEHOLDER);
    expect(blinded.severity).toBe("high");
    expect(blinded.category).toBe("bug");
    expect(blinded.evidence[0]!.quote).toBe("if (x)");
  });
});

function outcome(verdict: "confirm" | "reject" | "uncertain", error: string | null = null) {
  return {
    verdict,
    corroborated: verdict === "confirm",
    reason: "r",
    thirdModel: "glm-5.2",
    ms: 5,
    error,
  };
}

describe("runShadowReplay", () => {
  const candidate = {
    reviewId: REVIEW_ID,
    findingKey: candidateKey(REVIEW_ID, "anthropic", finding()),
    flaggingProvider: "anthropic",
    finding: finding(),
    origin: "single_model_tier" as const,
  };

  it("runs every (variant, run) cell through the judge and persists rows", async () => {
    const inserted: ShadowRunRow[] = [];
    const runOne = vi.fn().mockResolvedValue(outcome("confirm"));
    const summary = await runShadowReplay({
      candidates: [candidate],
      runsPerVariant: 2,
      variants: ["full", "blinded"],
      io: {
        hasRun: async () => false,
        insertRun: async (row) => {
          inserted.push(row);
        },
        runOne,
      },
    });
    expect(summary).toEqual({ attempted: 4, inserted: 4, skippedExisting: 0, errored: 0 });
    expect(inserted).toHaveLength(4);
    const blindedRows = inserted.filter((r) => r.variant === "blinded");
    expect(blindedRows).toHaveLength(2);
    // The blinded snapshot must be the redacted finding — determinism pin
    // records exactly what the judge saw.
    expect(blindedRows[0]!.findingSnapshot.title).toBe(BLINDED_PLACEHOLDER);
    const fullRows = inserted.filter((r) => r.variant === "full");
    expect(fullRows[0]!.findingSnapshot.title).toBe(finding().title);
  });

  it("skips existing cells (idempotent resume) and counts fail-open errors", async () => {
    const runOne = vi.fn().mockResolvedValue(outcome("uncertain", "api down"));
    const summary = await runShadowReplay({
      candidates: [candidate],
      runsPerVariant: 2,
      variants: ["full"],
      io: {
        hasRun: async (_key, _variant, runIndex) => runIndex === 0,
        insertRun: async () => undefined,
        runOne,
      },
    });
    expect(summary).toEqual({ attempted: 2, inserted: 1, skippedExisting: 1, errored: 1 });
    expect(runOne).toHaveBeenCalledTimes(1);
  });
});

function run(findingKey: string, variant: string, runIndex: number, verdict: string): StoredRun {
  return {
    findingKey,
    variant,
    runIndex,
    verdict,
    corroborated: verdict === "confirm",
    error: null,
  };
}

describe("computeShadowReport", () => {
  it("computes flip-rate, majority corroboration, and the confusion matrix", () => {
    const runs = [
      // event A: stable confirm (majority corroborated), labeled real → TP
      run("a", "full", 0, "confirm"),
      run("a", "full", 1, "confirm"),
      run("a", "full", 2, "confirm"),
      // event B: unstable, majority confirm (2/3), labeled not_real → FP
      run("b", "full", 0, "confirm"),
      run("b", "full", 1, "confirm"),
      run("b", "full", 2, "reject"),
      // event C: stable reject, labeled real → FN
      run("c", "full", 0, "reject"),
      run("c", "full", 1, "reject"),
      run("c", "full", 2, "reject"),
      // event D: unlabeled — excluded from the matrix, counted for stability
      run("d", "full", 0, "uncertain"),
      run("d", "full", 1, "uncertain"),
    ];
    const labels = [
      { findingKey: "a", label: "real" },
      { findingKey: "b", label: "not_real" },
      { findingKey: "c", label: "real" },
    ];
    const [report] = computeShadowReport(runs, labels);
    expect(report).toMatchObject({
      variant: "full",
      events: 4,
      unstableEvents: 1,
      corroboratedEvents: 2,
      labeled: 3,
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 1,
      trueNegatives: 0,
    });
    expect(report!.flipRate).toBeCloseTo(0.25);
    expect(report!.precision).toBeCloseTo(0.5);
  });

  it("reports variants separately and null precision with no corroborations", () => {
    const runs = [run("a", "full", 0, "reject"), run("a", "blinded", 0, "reject")];
    const reports = computeShadowReport(runs, [{ findingKey: "a", label: "real" }]);
    expect(reports.map((r) => r.variant)).toEqual(["blinded", "full"]);
    expect(reports[0]!.precision).toBe(null);
  });

  it("renders a markdown table with the corpus-bias note", () => {
    const runs = [run("a", "full", 0, "confirm")];
    const md = renderShadowReportMarkdown(
      computeShadowReport(runs, []),
      "2026-07-21T00:00:00.000Z",
    );
    expect(md).toContain("| full |");
    expect(md).toContain("Corpus bias:");
  });
});
