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
  confidence: "high",
  evidence: [{ path: "src/foo.ts", startLine: 5, endLine: 5, symbol: null, quote: null }],
  reasoning: "x",
  reproduction: null,
  recommendation: "y",
  whyTestsDoNotAlreadyCoverThis: "",
  suggestedRegressionTest: null,
  minimumFixScope: "",
  ...overrides,
});

const stubFile = (): ChangedFile => ({
  filename: "src/foo.ts",
  contents: "x",
  status: "modified",
  sha: "abc",
  patch: "@@ -1,5 +1,10 @@\n const a = 1;\n+added\n",
});

const opus: PatchProposingProvider = {
  name: "anthropic",
  async proposePatch() {
    return { patch: "-old\n+new\n", rationale: null };
  },
};

const gpt: PatchProposingProvider = {
  name: "openai",
  async proposePatch() {
    return { patch: "-old\n+other\n", rationale: null };
  },
};

describe("runPatchAgent — env-flag gate", () => {
  it("returns null when disabled", async () => {
    const out = await runPatchAgent({
      reviewId: "rev-1",
      installationId: 12345,
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
      findings: [stubFinding()],
      changedFiles: [stubFile()],
      providers: [opus, gpt],
      enabled: () => true,
    });
    const patch = out!.byIndex.get(0);
    expect(patch).toBeDefined();
    expect(patch?.patch).toBe("-old\n+new\n");
    expect(patch?.modelId).toBe("claude-opus-4-7");
  });

  it("omits the byIndex entry when the gate skips (one-sided)", async () => {
    const onlyOpus = opus;
    const decline: PatchProposingProvider = {
      name: "openai",
      async proposePatch() {
        return { patch: null, rationale: null };
      },
    };
    const out = await runPatchAgent({
      reviewId: "rev-1",
      installationId: 12345,
      findings: [stubFinding()],
      changedFiles: [stubFile()],
      providers: [onlyOpus, decline],
      enabled: () => true,
    });
    expect(out!.byIndex.size).toBe(0);
    expect(out!.decisions[0]?.skipReason).toBe("models_disagreed");
  });
});

describe("runPatchAgent — degenerate paths", () => {
  it("returns empty outcome when no findings", async () => {
    const out = await runPatchAgent({
      reviewId: "rev-1",
      installationId: 12345,
      findings: [],
      changedFiles: [],
      providers: [opus, gpt],
      enabled: () => true,
    });
    expect(out).toEqual({ decisions: [], byIndex: new Map(), elapsedMs: 0 });
  });

  it("short-circuits when fewer than 2 providers are configured", async () => {
    const out = await runPatchAgent({
      reviewId: "rev-1",
      installationId: 12345,
      findings: [stubFinding()],
      changedFiles: [stubFile()],
      providers: [opus],
      enabled: () => true,
    });
    expect(out!.byIndex.size).toBe(0);
    expect(out!.decisions).toEqual([]);
  });
});
