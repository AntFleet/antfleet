import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChangedFile } from "./github-files";

// Stub the triage pre-pass so each test controls its decision.
const triagePRMock = vi.fn();
vi.mock("./triage-provider", () => ({
  triagePR: (...args: unknown[]) => triagePRMock(...args),
  TRIAGE_COST_USD: 0.001,
}));

// Stub the frontier providers so they never hit the network, and so we can
// assert whether they were called. The agreement / prompt / cost modules are
// pure and used for real.
const anthropicReview = vi.fn();
const openaiReview = vi.fn();
vi.mock("@antfleet/cli/providers/anthropic", () => ({
  anthropicProvider: { name: "anthropic", review: (...a: unknown[]) => anthropicReview(...a) },
  ANTHROPIC_DEFAULT_MODEL: "claude-opus-4-7",
}));
vi.mock("@antfleet/cli/providers/openai", () => ({
  openaiProvider: { name: "openai", review: (...a: unknown[]) => openaiReview(...a) },
  OPENAI_DEFAULT_MODEL: "gpt-5.5",
}));

import { reviewPR, selectSingleModelTier } from "./review-pipeline";
import type { Disagreement, Finding } from "./review-types";

function mkFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    filename: "src/x.ts",
    contents: "export const x = 1;",
    status: "modified",
    sha: "sha-1",
    patch: null,
    ...overrides,
  };
}

// Minimal valid-enough ReviewOutput: mergeFindings only reads `.findings`.
function mkOutput() {
  return { findings: [], inspected: { files: [], symbols: [], notes: [] } };
}

function escalate() {
  return {
    worthEscalating: true,
    reason: "logic change",
    modelId: "claude-haiku-4-5",
    ms: 4,
    error: null,
  };
}

beforeEach(() => {
  triagePRMock.mockReset();
  anthropicReview.mockReset();
  openaiReview.mockReset();
});

describe("reviewPR triage pre-pass", () => {
  it("returns an empty bundle and skips the frontier when triage declines a docs-only PR", async () => {
    triagePRMock.mockResolvedValue({
      worthEscalating: false,
      reason: "docs only",
      modelId: "claude-haiku-4-5",
      ms: 3,
      error: null,
    });

    // Docs-only PR — the deterministic source-code guard does not fire, so the
    // triage skip stands.
    const bundle = await reviewPR({
      files: [mkFile({ filename: "README.md", contents: "# docs" })],
      owner: "o",
      repo: "r",
      prNumber: 1,
    });

    expect(bundle.agreed).toEqual([]);
    expect(bundle.perProvider).toEqual([]);
    expect(bundle.estimatedCostUsd).toBe(0);
    expect(bundle.degraded).toBe(false);
    expect(bundle.triage?.worthEscalating).toBe(false);
    expect(anthropicReview).not.toHaveBeenCalled();
    expect(openaiReview).not.toHaveBeenCalled();
  });

  it("overrides a triage skip and escalates when any source-code file is present", async () => {
    // Triage votes to skip, but a .ts file is in the changeset. The
    // deterministic guard must force escalation regardless — this is the
    // defense against a confidently-wrong or prompt-injected skip.
    triagePRMock.mockResolvedValue({
      worthEscalating: false,
      reason: "claims docs only",
      modelId: "claude-haiku-4-5",
      ms: 3,
      error: null,
    });
    anthropicReview.mockResolvedValue(mkOutput());
    openaiReview.mockResolvedValue(mkOutput());

    const bundle = await reviewPR({
      files: [mkFile({ filename: "apps/web/lib/foo.ts", contents: "export const x = 1;" })],
      owner: "o",
      repo: "r",
      prNumber: 1,
    });

    expect(anthropicReview).toHaveBeenCalledTimes(1);
    expect(openaiReview).toHaveBeenCalledTimes(1);
    expect(bundle.triage?.worthEscalating).toBe(true);
    expect(bundle.triage?.reason).toMatch(/overridden/u);
    expect(bundle.perProvider).toHaveLength(2);
  });

  it("overrides a triage skip for a CI-workflow-only (.yml) PR", async () => {
    // .yml workflows are a real attack vector (privilege escalation, secret
    // exfiltration) and are NOT in the docs-only skippable allowlist, so a
    // workflow-only PR must escalate even when triage votes to skip.
    triagePRMock.mockResolvedValue({
      worthEscalating: false,
      reason: "claims config only",
      modelId: "claude-haiku-4-5",
      ms: 3,
      error: null,
    });
    anthropicReview.mockResolvedValue(mkOutput());
    openaiReview.mockResolvedValue(mkOutput());

    const bundle = await reviewPR({
      files: [
        mkFile({ filename: ".github/workflows/ci.yml", contents: "on: pull_request_target" }),
      ],
      owner: "o",
      repo: "r",
      prNumber: 1,
    });

    expect(anthropicReview).toHaveBeenCalledTimes(1);
    expect(bundle.triage?.worthEscalating).toBe(true);
    expect(bundle.triage?.reason).toMatch(/overridden/u);
  });

  it("fails open: still runs the frontier when triage errors", async () => {
    triagePRMock.mockResolvedValue({
      worthEscalating: true,
      reason: "triage error — failing open",
      modelId: "claude-haiku-4-5",
      ms: 2,
      error: "anthropic 500 boom",
    });
    anthropicReview.mockResolvedValue(mkOutput());
    openaiReview.mockResolvedValue(mkOutput());

    const bundle = await reviewPR({ files: [mkFile()], owner: "o", repo: "r", prNumber: 1 });

    expect(anthropicReview).toHaveBeenCalledTimes(1);
    expect(openaiReview).toHaveBeenCalledTimes(1);
    expect(bundle.triage?.error).toBe("anthropic 500 boom");
    // Frontier cost + the triage call's fixed cost.
    expect(bundle.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("includes the triage result on the escalated path", async () => {
    triagePRMock.mockResolvedValue(escalate());
    anthropicReview.mockResolvedValue(mkOutput());
    openaiReview.mockResolvedValue(mkOutput());

    const bundle = await reviewPR({ files: [mkFile()], owner: "o", repo: "r", prNumber: 1 });

    expect(bundle.triage?.worthEscalating).toBe(true);
    expect(anthropicReview).toHaveBeenCalledTimes(1);
  });

  it("never calls triage when mode is not unanimous; triage is null", async () => {
    anthropicReview.mockResolvedValue(mkOutput());
    openaiReview.mockResolvedValue(mkOutput());

    const bundle = await reviewPR({
      files: [mkFile()],
      owner: "o",
      repo: "r",
      prNumber: 1,
      mode: "any",
    });

    expect(triagePRMock).not.toHaveBeenCalled();
    expect(bundle.triage).toBeNull();
    expect(anthropicReview).toHaveBeenCalledTimes(1);
    expect(openaiReview).toHaveBeenCalledTimes(1);
  });
});

// ── Win 2 — single-model shadow tier selection ──────────────────────────────

const mkFinding = (overrides: Partial<Finding> = {}): Finding => ({
  title: "Title",
  category: "security",
  severity: "high",
  label: "blocking",
  confidence: "high",
  evidence: [{ path: "src/foo.ts", startLine: 10, endLine: 20, symbol: null, quote: null }],
  reasoning: "Reasoning text",
  reproduction: null,
  recommendation: "Recommendation text",
  whyTestsDoNotAlreadyCoverThis: "",
  suggestedRegressionTest: null,
  minimumFixScope: "",
  requiresPolicyReview: false,
  upstreamOrigin: null,
  ...overrides,
});

const mkDisagreement = (providers: string[], finding: Finding): Disagreement => ({
  providers,
  finding,
  reason: `only ${providers.length} flagged`,
});

describe("selectSingleModelTier (projection)", () => {
  it("includes HIGH and CRITICAL single-provider disagreements", () => {
    const high = mkDisagreement(["anthropic"], mkFinding({ severity: "high" }));
    const crit = mkDisagreement(["openai"], mkFinding({ severity: "critical" }));
    const out = selectSingleModelTier([high, crit]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ finding: high.finding, provider: "anthropic" });
    expect(out[1]).toEqual({ finding: crit.finding, provider: "openai" });
  });

  it("carries the flagging provider (Build B forward-compat)", () => {
    const out = selectSingleModelTier([
      mkDisagreement(["openai"], mkFinding({ severity: "critical" })),
    ]);
    expect(out[0]?.provider).toBe("openai");
  });

  it("excludes MEDIUM and LOW single-provider disagreements", () => {
    const out = selectSingleModelTier([
      mkDisagreement(["anthropic"], mkFinding({ severity: "medium" })),
      mkDisagreement(["openai"], mkFinding({ severity: "low" })),
    ]);
    expect(out).toEqual([]);
  });

  it("excludes disagreements flagged by more than one provider", () => {
    // A 2-provider disagreement is not a single-model finding, even at HIGH.
    const out = selectSingleModelTier([
      mkDisagreement(["anthropic", "openai"], mkFinding({ severity: "high" })),
    ]);
    expect(out).toEqual([]);
  });
});

describe("reviewPR single-model shadow tier", () => {
  const ORIGINAL = process.env["ANTFLEET_SINGLE_MODEL_TIER"];
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env["ANTFLEET_SINGLE_MODEL_TIER"];
    else process.env["ANTFLEET_SINGLE_MODEL_TIER"] = ORIGINAL;
  });

  // anthropic flags a HIGH finding; openai flags nothing → a single-model
  // HIGH disagreement under the unanimous gate.
  function singleModelOutputs() {
    anthropicReview.mockResolvedValue({
      findings: [mkFinding({ severity: "high" })],
      inspected: { files: [], symbols: [], notes: [] },
    });
    openaiReview.mockResolvedValue(mkOutput());
  }

  it("populates singleModelTier with the HIGH single-model finding when the flag is ON", async () => {
    process.env["ANTFLEET_SINGLE_MODEL_TIER"] = "true";
    triagePRMock.mockResolvedValue(escalate());
    singleModelOutputs();

    const bundle = await reviewPR({ files: [mkFile()], owner: "o", repo: "r", prNumber: 1 });

    expect(bundle.agreed).toEqual([]);
    expect(bundle.singleModelTier).toHaveLength(1);
    expect(bundle.singleModelTier[0]?.finding.severity).toBe("high");
    expect(bundle.singleModelTier[0]?.provider).toBe("anthropic");
  });

  it("keeps singleModelTier EMPTY when the flag is OFF (inert by default)", async () => {
    delete process.env["ANTFLEET_SINGLE_MODEL_TIER"];
    triagePRMock.mockResolvedValue(escalate());
    singleModelOutputs();

    const bundle = await reviewPR({ files: [mkFile()], owner: "o", repo: "r", prNumber: 1 });

    // Same disagreement is present, but the tier projection is inert.
    expect(bundle.disagreements).toHaveLength(1);
    expect(bundle.singleModelTier).toEqual([]);
  });

  it("does not change agreed[] whether the flag is ON or OFF (byte-identical)", async () => {
    triagePRMock.mockResolvedValue(escalate());
    // Both providers flag the same finding → agreed.
    const shared = mkFinding({ severity: "high", title: "Shared" });
    const bothOutputs = () => {
      anthropicReview.mockResolvedValue({
        findings: [shared],
        inspected: { files: [], symbols: [], notes: [] },
      });
      openaiReview.mockResolvedValue({
        findings: [shared],
        inspected: { files: [], symbols: [], notes: [] },
      });
    };

    delete process.env["ANTFLEET_SINGLE_MODEL_TIER"];
    bothOutputs();
    const off = await reviewPR({ files: [mkFile()], owner: "o", repo: "r", prNumber: 1 });

    process.env["ANTFLEET_SINGLE_MODEL_TIER"] = "true";
    bothOutputs();
    const on = await reviewPR({ files: [mkFile()], owner: "o", repo: "r", prNumber: 1 });

    expect(on.agreed).toEqual(off.agreed);
    expect(on.agreed).toHaveLength(1);
    expect(on.singleModelTier).toEqual([]);
  });

  it("returns [] for a degraded review even with the flag ON", async () => {
    process.env["ANTFLEET_SINGLE_MODEL_TIER"] = "true";
    triagePRMock.mockResolvedValue(escalate());
    // Only one provider succeeds → degraded (unanimous requires 2).
    anthropicReview.mockResolvedValue({
      findings: [mkFinding({ severity: "critical" })],
      inspected: { files: [], symbols: [], notes: [] },
    });
    openaiReview.mockRejectedValue(new Error("openai 500"));

    const bundle = await reviewPR({ files: [mkFile()], owner: "o", repo: "r", prNumber: 1 });

    expect(bundle.degraded).toBe(true);
    expect(bundle.singleModelTier).toEqual([]);
  });
});

// ── Issue #134 — per-provider transient classification ──────────────────────
// The worker reads perProvider[i].transient to decide whether a degraded
// review deserves a retry for consensus. A failed provider must be tagged
// with its error's transience; a successful provider is always non-transient.

describe("reviewPR per-provider transient flag", () => {
  it("flags a transient provider failure true and the surviving success false", async () => {
    triagePRMock.mockResolvedValue(escalate());
    // anthropic succeeds; openai throws a 429 (transient infra noise).
    anthropicReview.mockResolvedValue(mkOutput());
    openaiReview.mockRejectedValue(new Error("HTTP 429 rate limit exceeded"));

    const bundle = await reviewPR({ files: [mkFile()], owner: "o", repo: "r", prNumber: 1 });

    const anthropic = bundle.perProvider.find((p) => p.name === "anthropic");
    const openai = bundle.perProvider.find((p) => p.name === "openai");
    // Success path: no error to classify → transient false.
    expect(anthropic?.output).not.toBeNull();
    expect(anthropic?.transient).toBe(false);
    // Failure path: 429 is transient.
    expect(openai?.output).toBeNull();
    expect(openai?.error).toContain("429");
    expect(openai?.transient).toBe(true);
    expect(bundle.degraded).toBe(true);
  });

  it("classifies an unrecognized provider error as transient (heuristic catch-all)", async () => {
    // isTransientError is an allowlist of transient patterns with a transient
    // DEFAULT (a whole-pipeline throw is almost always infra). So even an
    // error with no recognized keyword is flagged transient. Documented here
    // so the worker's non-transient branch — which requires transient===false
    // on a failed provider — is understood to be effectively unreachable via
    // this heuristic today; a future non-transient classifier (e.g. a 4xx-
    // other-than-429 denylist) would flip real cases to false without any
    // worker change. The worker's own test injects transient:false directly.
    triagePRMock.mockResolvedValue(escalate());
    anthropicReview.mockResolvedValue(mkOutput());
    openaiReview.mockRejectedValue(new Error("model returned malformed output"));

    const bundle = await reviewPR({ files: [mkFile()], owner: "o", repo: "r", prNumber: 1 });

    const openai = bundle.perProvider.find((p) => p.name === "openai");
    expect(openai?.output).toBeNull();
    expect(openai?.transient).toBe(true);
  });

  it("is always false on the success path regardless of the error heuristic", async () => {
    // Both providers succeed → no error to classify → transient false on both.
    triagePRMock.mockResolvedValue(escalate());
    anthropicReview.mockResolvedValue(mkOutput());
    openaiReview.mockResolvedValue(mkOutput());

    const bundle = await reviewPR({ files: [mkFile()], owner: "o", repo: "r", prNumber: 1 });

    expect(bundle.perProvider.every((p) => p.transient === false)).toBe(true);
    expect(bundle.degraded).toBe(false);
  });
});
