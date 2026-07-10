import { describe, it, expect } from "vitest";
import { runPatchAgent } from "./patch-agent";
import type { PatchProposingProvider } from "./patch-generation";
import type { Finding } from "./review-types";
import type { ChangedFile } from "./github-files";

// Patch Agent v1.5 — top-level orchestrator integration tests. The
// individual primitives are tested in patch-generation.test.ts and
// patch-gate.test.ts; here we just verify the wiring + env-flag gate.

const stubFinding = (overrides: Partial<Finding> = {}): Finding => ({
  title: "Off-by-one",
  category: "bug",
  severity: "high",
  label: "blocking",
  confidence: "high",
  evidence: [{ path: "src/foo.ts", startLine: 10, endLine: 10, symbol: null, quote: null }],
  reasoning: "x",
  reproduction: null,
  recommendation: "y",
  whyTestsDoNotAlreadyCoverThis: "",
  suggestedRegressionTest: null,
  minimumFixScope: "",
  requiresPolicyReview: false,
  upstreamOrigin: null,
  ...overrides,
});

// Real source of src/foo.ts. The apply-floor (in generateReviewPatches)
// anchors each proposed patch's old-side `old` against this content; the
// provider patches below therefore edit an `old` line that must exist here.
const STUB_FILE_CONTENTS = "const a = 1;\nold\nline-a\nline-b\nline-c\nline-d\nline-e\n";

const stubFile = (): ChangedFile => ({
  filename: "src/foo.ts",
  contents: STUB_FILE_CONTENTS,
  status: "modified",
  sha: "abc",
  patch: "@@ -1,10 +1,15 @@\n const a = 1;\n+added\n",
});

const opus: PatchProposingProvider = {
  name: "anthropic",
  async proposePatch() {
    return {
      patch: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -10,1 +10,1 @@\n-old\n+new\n",
      rationale: null,
      modelId: "claude-opus-4-7",
    };
  },
};

const gpt: PatchProposingProvider = {
  name: "openai",
  async proposePatch() {
    return {
      patch: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -10,1 +10,1 @@\n-old\n+other\n",
      rationale: null,
      modelId: "gpt-5.5",
    };
  },
};

describe("runPatchAgent — env-flag gate", () => {
  it("returns null when disabled", async () => {
    const out = await runPatchAgent({
      reviewId: "rev-1",
      installationId: 12345,
      repo: "test-repo",
      findings: [stubFinding()],
      changedFiles: [stubFile()],
      providers: [opus, gpt],
      enabled: () => false,
    });
    expect(out).toBeNull();
  });

  it("returns an outcome when enabled", async () => {
    const out = await runPatchAgent({
      reviewId: "rev-1",
      installationId: 12345,
      repo: "test-repo",
      findings: [stubFinding()],
      changedFiles: [stubFile()],
      providers: [opus, gpt],
      enabled: () => true,
    });
    expect(out).not.toBeNull();
    expect(out!.decisions).toHaveLength(1);
    expect(out!.byIndex.size).toBe(1);
  });
});

describe("runPatchAgent — happy path", () => {
  it("emits a PatchForRender keyed by original finding index", async () => {
    const out = await runPatchAgent({
      reviewId: "rev-1",
      installationId: 12345,
      repo: "test-repo",
      findings: [stubFinding()],
      changedFiles: [stubFile()],
      providers: [opus, gpt],
      enabled: () => true,
    });
    const patch = out!.byIndex.get(0);
    expect(patch).toBeDefined();
    // Shipped patch is the apply-floor's re-anchored form; assert content
    // rather than byte identity with the raw model output.
    expect(patch?.patch).toContain("-old");
    expect(patch?.patch).toContain("+new");
    expect(patch?.modelId).toBe("claude-opus-4-7");
    expect(patch?.mode).toBe("inline");
    expect(out!.inlineByIndex.get(0)).toEqual(patch);
  });

  it("computes a real cost and per-finding token split from provider usage", async () => {
    const opusWithUsage: PatchProposingProvider = {
      name: "anthropic",
      async proposePatch() {
        return {
          patch: "@@ -10,1 +10,1 @@\n-old\n+new\n",
          rationale: null,
          modelId: "claude-opus-4-7",
          usage: { inputTokens: 1000, outputTokens: 1000 },
        };
      },
    };
    const gptWithUsage: PatchProposingProvider = {
      name: "openai",
      async proposePatch() {
        return {
          patch: "@@ -10,1 +10,1 @@\n-old\n+other\n",
          rationale: null,
          modelId: "gpt-5.5",
          usage: { inputTokens: 1000, outputTokens: 1000 },
        };
      },
    };
    const out = await runPatchAgent({
      reviewId: "rev-1",
      installationId: 12345,
      repo: "test-repo",
      findings: [stubFinding()],
      changedFiles: [stubFile()],
      providers: [opusWithUsage, gptWithUsage],
      enabled: () => true,
    });
    // Opus 0.09 + GPT-5 0.035 = 0.125 (was hardcoded 0 before this change).
    expect(out!.costPatchUsd).toBe(0.125);
    const fid = out!.decisions[0]!.findingId;
    expect(out!.tokensByFindingId.get(fid)).toEqual({
      opus: { inputTokens: 1000, outputTokens: 1000 },
      gpt5: { inputTokens: 1000, outputTokens: 1000 },
    });
  });

  it("ships the lone opus patch as single_model when the other side declines", async () => {
    // v2 verifier-first inversion: a one-sided valid patch now flows through
    // to byIndex (and thus to the downstream verifier) instead of being nulled
    // into models_disagreed. The decision carries confidence single_model.
    const onlyOpus = opus;
    const decline: PatchProposingProvider = {
      name: "openai",
      async proposePatch() {
        return { patch: null, rationale: null, modelId: "gpt-5.5" };
      },
    };
    const out = await runPatchAgent({
      reviewId: "rev-1",
      installationId: 12345,
      repo: "test-repo",
      findings: [stubFinding()],
      changedFiles: [stubFile()],
      providers: [onlyOpus, decline],
      enabled: () => true,
    });
    expect(out!.byIndex.size).toBe(1);
    // Shipped patch is the apply-floor's re-anchored form.
    expect(out!.byIndex.get(0)?.patch).toContain("-old");
    expect(out!.byIndex.get(0)?.patch).toContain("+new");
    expect(out!.byIndex.get(0)?.confidence).toBe("single_model");
    expect(out!.decisions[0]?.gateOutcome).toBeNull();
    expect(out!.decisions[0]?.confidence).toBe("single_model");
    expect(out!.decisions[0]?.rationales).toEqual({ opus: null, gpt5: null });
  });
});

describe("runPatchAgent — degenerate paths", () => {
  it("returns empty outcome when no findings", async () => {
    const out = await runPatchAgent({
      reviewId: "rev-1",
      installationId: 12345,
      repo: "test-repo",
      findings: [],
      changedFiles: [],
      providers: [opus, gpt],
      enabled: () => true,
    });
    expect(out).toEqual({
      decisions: [],
      byIndex: new Map(),
      inlineByIndex: new Map(),
      elapsedMs: 0,
      costPatchUsd: 0,
      tokensByFindingId: new Map(),
    });
  });

  it("short-circuits when anthropic is missing even if 2+ providers are present", async () => {
    // Audit-response fix: previously this would burn API calls before
    // the gate returned models_disagreed. The orchestrator now matches
    // the gate's "winning provider must be anthropic" rule.
    let calls = 0;
    const openaiOnly: PatchProposingProvider = {
      name: "openai",
      async proposePatch() {
        calls += 1;
        return { patch: "...", rationale: null, modelId: "stub-model" };
      },
    };
    const third: PatchProposingProvider = {
      name: "openrouter",
      async proposePatch() {
        calls += 1;
        return { patch: "...", rationale: null, modelId: "stub-model" };
      },
    };
    const out = await runPatchAgent({
      reviewId: "rev-1",
      installationId: 12345,
      repo: "test-repo",
      findings: [stubFinding()],
      changedFiles: [stubFile()],
      providers: [openaiOnly, third],
      enabled: () => true,
    });
    expect(calls).toBe(0);
    expect(out!.byIndex.size).toBe(0);
    expect(out!.decisions).toEqual([]);
  });

  it("short-circuits when fewer than 2 providers are configured", async () => {
    const out = await runPatchAgent({
      reviewId: "rev-1",
      installationId: 12345,
      repo: "test-repo",
      findings: [stubFinding()],
      changedFiles: [stubFile()],
      providers: [opus],
      enabled: () => true,
    });
    expect(out!.byIndex.size).toBe(0);
    expect(out!.decisions).toEqual([]);
  });

  it("renders agreed out-of-hunk patches as artifacts, not inline click-apply patches", async () => {
    const out = await runPatchAgent({
      reviewId: "rev-1",
      installationId: 12345,
      repo: "test-repo",
      findings: [
        stubFinding({
          evidence: [{ path: "src/foo.ts", startLine: 50, endLine: 50, symbol: null, quote: null }],
        }),
      ],
      changedFiles: [stubFile()],
      providers: [
        {
          name: "anthropic",
          async proposePatch() {
            return {
              patch: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -50,1 +50,1 @@\n-old\n+new\n",
              rationale: null,
              modelId: "claude-opus-4-7",
            };
          },
        },
        {
          name: "openai",
          async proposePatch() {
            return {
              patch: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -50,1 +50,1 @@\n-old\n+other\n",
              rationale: null,
              modelId: "gpt-5.5",
            };
          },
        },
      ],
      enabled: () => true,
    });
    expect(out!.byIndex.get(0)?.mode).toBe("artifact");
    expect(out!.inlineByIndex.size).toBe(0);
  });
});
