import { describe, it, expect } from "vitest";
import {
  generateReviewPatches,
  PATCH_SIZE_LINE_CAP,
  buildPatchPrompt,
  type PatchProposingProvider,
  type GenerateReviewPatchesArgs,
} from "./patch-generation";
import type { Finding } from "./review-types";
import type { ChangedFile } from "./github-files";

// Patch Agent v1.5 — orchestrator unit tests. Provider calls are mocked
// because PR2 only ships the primitives; the wiring to live providers
// happens in PR4. These tests pin the four post-call validation paths the
// gate (PR3) downstream depends on.

const stubFinding = (overrides: Partial<Finding> = {}): Finding => ({
  title: "Off-by-one in counter init",
  category: "bug",
  severity: "high",
  confidence: "high",
  evidence: [
    { path: "src/foo.ts", startLine: 10, endLine: 12, symbol: "counter", quote: null },
  ],
  reasoning: "Stub.",
  reproduction: "Stub.",
  recommendation: "Stub.",
  whyTestsDoNotAlreadyCoverThis: "Stub.",
  suggestedRegressionTest: null,
  minimumFixScope: "Stub.",
  ...overrides,
});

const stubFile = (overrides: Partial<ChangedFile> = {}): ChangedFile => ({
  filename: "src/foo.ts",
  contents: "const a = 1;\n",
  status: "modified",
  sha: "abc",
  patch: "@@ -1,5 +1,15 @@\n const a = 1;\n+added\n+added\n+added\n+added\n",
  ...overrides,
});

const buildProvider = (
  name: string,
  impl: (finding: Finding) => Promise<{ patch: string | null; rationale: string | null }>,
): PatchProposingProvider => ({
  name,
  async proposePatch(_root, prompt) {
    // Read the finding title back from the prompt so the impl can route on it.
    const titleMatch = /flagged a (?:bug|security|performance|concurrency|api-contract|data-loss|test-gap|docs-gap|build-release|maintainability)[^]*?titled:\s*\n\s+(.+)/u.exec(
      prompt,
    );
    const title = titleMatch?.[1] ?? "";
    const result = await impl(stubFinding({ title }));
    // The provider modules attach the resolved modelId; the test harness
    // synthesizes one so the orchestrator's modelId-threading is exercised.
    return { ...result, modelId: `${name}-test-model` };
  },
});

const baseArgs = (overrides: Partial<GenerateReviewPatchesArgs> = {}): GenerateReviewPatchesArgs => ({
  reviewId: "rev-1",
  findings: [stubFinding()],
  findingIds: ["fid-1"],
  changedFiles: [stubFile()],
  providers: [],
  ...overrides,
});

describe("generateReviewPatches — fan-out", () => {
  it("returns one proposal per (finding × provider)", async () => {
    const opus = buildProvider("anthropic", async () => ({
      patch: "@@ -10,1 +10,1 @@\n-old\n+new\n",
      rationale: "Trivial swap.",
    }));
    const gpt = buildProvider("openai", async () => ({ patch: null, rationale: "decline" }));
    const result = await generateReviewPatches(baseArgs({ providers: [opus, gpt] }));
    expect(result.proposals).toHaveLength(2);
    const byProvider = new Map(result.proposals.map((p) => [p.providerName, p]));
    expect(byProvider.get("anthropic")?.patch).toContain("+new");
    expect(byProvider.get("openai")?.patch).toBeNull();
  });

  it("runs all (finding × provider) pairs in parallel — wall-clock ~ slowest single call", async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const make = (delayMs: number): PatchProposingProvider => ({
      name: `p${delayMs}`,
      async proposePatch() {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((r) => setTimeout(r, delayMs));
        inFlight -= 1;
        return { patch: null, rationale: null, modelId: "stub-model" };
      },
    });
    const findings = [stubFinding(), stubFinding({ title: "F2" })];
    await generateReviewPatches({
      reviewId: "rev-x",
      findings,
      findingIds: ["a", "b"],
      changedFiles: [stubFile()],
      providers: [make(15), make(20)],
    });
    // 2 findings × 2 providers = 4 concurrent calls.
    expect(peakInFlight).toBe(4);
  });
});

describe("generateReviewPatches — diff-hunk filter", () => {
  it("emits outside_diff_hunk when evidence.startLine is null (file-level finding)", async () => {
    const provider = buildProvider("anthropic", async () => {
      throw new Error("should not reach provider");
    });
    const finding = stubFinding({
      evidence: [{ path: "src/foo.ts", startLine: null, endLine: null, symbol: null, quote: null }],
    });
    const result = await generateReviewPatches(
      baseArgs({ findings: [finding], providers: [provider] }),
    );
    expect(result.proposals[0]?.patch).toBeNull();
    expect(result.proposals[0]?.skipReason).toBe("outside_diff_hunk");
  });

  it("emits outside_diff_hunk when evidence path is missing from PR diff", async () => {
    const provider = buildProvider("anthropic", async () => {
      throw new Error("should not reach provider");
    });
    const finding = stubFinding({
      evidence: [{ path: "src/unknown.ts", startLine: 5, endLine: 5, symbol: null, quote: null }],
    });
    const result = await generateReviewPatches(
      baseArgs({ findings: [finding], providers: [provider] }),
    );
    expect(result.proposals[0]?.skipReason).toBe("outside_diff_hunk");
  });

  it("emits outside_diff_hunk when evidence range lies outside the hunk", async () => {
    const provider = buildProvider("anthropic", async () => {
      throw new Error("should not reach provider");
    });
    const finding = stubFinding({
      // Hunk in stubFile covers lines 1..15 — 50 is well outside.
      evidence: [{ path: "src/foo.ts", startLine: 50, endLine: 52, symbol: null, quote: null }],
    });
    const result = await generateReviewPatches(
      baseArgs({ findings: [finding], providers: [provider] }),
    );
    expect(result.proposals[0]?.skipReason).toBe("outside_diff_hunk");
  });

  it("reaches the provider when evidence lies inside a hunk", async () => {
    let called = false;
    const provider: PatchProposingProvider = {
      name: "anthropic",
      async proposePatch() {
        called = true;
        return { patch: "@@ -10,1 +10,1 @@\n-old\n+new\n", rationale: null, modelId: "stub-model" };
      },
    };
    const result = await generateReviewPatches(baseArgs({ providers: [provider] }));
    expect(called).toBe(true);
    expect(result.proposals[0]?.patch).toContain("+new");
  });
});

describe("generateReviewPatches — size cap", () => {
  it("emits size_cap when the patch exceeds the 20-line cap", async () => {
    const oversizePatch =
      "@@ -10,1 +10,30 @@\n" + Array.from({ length: 30 }, (_, i) => `+line${i}\n`).join("");
    const provider = buildProvider("anthropic", async () => ({
      patch: oversizePatch,
      rationale: "lots to fix",
    }));
    const result = await generateReviewPatches(baseArgs({ providers: [provider] }));
    expect(result.proposals[0]?.patch).toBeNull();
    expect(result.proposals[0]?.skipReason).toBe("size_cap");
    expect(result.proposals[0]?.rationale).toBe("lots to fix");
  });

  it("accepts a patch exactly at the 20-line cap", async () => {
    const cappedPatch =
      "@@ -10,1 +10,20 @@\n" +
      Array.from({ length: PATCH_SIZE_LINE_CAP }, (_, i) => `+l${i}\n`).join("");
    const provider = buildProvider("anthropic", async () => ({
      patch: cappedPatch,
      rationale: null,
    }));
    const result = await generateReviewPatches(baseArgs({ providers: [provider] }));
    expect(result.proposals[0]?.patch).toBe(cappedPatch);
    expect(result.proposals[0]?.skipReason).toBeNull();
  });
});

describe("generateReviewPatches — failure isolation", () => {
  it("emits generation_error when the provider throws", async () => {
    const provider: PatchProposingProvider = {
      name: "anthropic",
      async proposePatch() {
        throw new Error("API 500");
      },
    };
    const result = await generateReviewPatches(baseArgs({ providers: [provider] }));
    expect(result.proposals[0]?.patch).toBeNull();
    expect(result.proposals[0]?.skipReason).toBe("generation_error");
  });

  it("emits generation_error when the provider exceeds the timeout", async () => {
    const provider: PatchProposingProvider = {
      name: "slow",
      async proposePatch() {
        await new Promise((r) => setTimeout(r, 80));
        return { patch: null, rationale: null, modelId: "stub-model" };
      },
    };
    const result = await generateReviewPatches(
      baseArgs({ providers: [provider], timeoutMs: 20 }),
    );
    expect(result.proposals[0]?.skipReason).toBe("generation_error");
  });

  it("isolates one provider's failure from another's success", async () => {
    const opus: PatchProposingProvider = {
      name: "anthropic",
      async proposePatch() {
        return { patch: "@@ -10,1 +10,1 @@\n-old\n+new\n", rationale: null, modelId: "stub-model" };
      },
    };
    const gpt: PatchProposingProvider = {
      name: "openai",
      async proposePatch() {
        throw new Error("API 500");
      },
    };
    const result = await generateReviewPatches(baseArgs({ providers: [opus, gpt] }));
    const byName = new Map(result.proposals.map((p) => [p.providerName, p]));
    expect(byName.get("anthropic")?.patch).toContain("+new");
    expect(byName.get("openai")?.skipReason).toBe("generation_error");
  });
});

describe("generateReviewPatches — null patch decline", () => {
  it("carries through patch=null with rationale and no skipReason", async () => {
    const provider = buildProvider("anthropic", async () => ({
      patch: null,
      rationale: "fix would need a new helper",
    }));
    const result = await generateReviewPatches(baseArgs({ providers: [provider] }));
    expect(result.proposals[0]?.patch).toBeNull();
    expect(result.proposals[0]?.skipReason).toBeNull();
    expect(result.proposals[0]?.rationale).toBe("fix would need a new helper");
  });
});

describe("generateReviewPatches — input validation", () => {
  it("throws when findings and findingIds lengths disagree", async () => {
    await expect(
      generateReviewPatches({
        reviewId: "r",
        findings: [stubFinding(), stubFinding()],
        findingIds: ["only-one"],
        changedFiles: [stubFile()],
        providers: [],
      }),
    ).rejects.toThrow(/align/u);
  });

  it("emits an empty proposal list when no findings are passed", async () => {
    const result = await generateReviewPatches(
      baseArgs({ findings: [], findingIds: [], providers: [] }),
    );
    expect(result.proposals).toEqual([]);
  });
});

describe("buildPatchPrompt", () => {
  it("includes the title, target, and size cap", () => {
    const prompt = buildPatchPrompt(stubFinding());
    expect(prompt).toContain("Off-by-one in counter init");
    expect(prompt).toContain("src/foo.ts:10-12");
    expect(prompt).toContain("≤ 20 added lines");
  });

  it("renders '(none provided)' when reproduction is null", () => {
    const prompt = buildPatchPrompt(stubFinding({ reproduction: null }));
    expect(prompt).toContain("(none provided)");
  });
});
