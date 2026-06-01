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
  evidence: [{ path: "src/foo.ts", startLine: 10, endLine: 12, symbol: "counter", quote: null }],
  reasoning: "Stub.",
  reproduction: "Stub.",
  recommendation: "Stub.",
  whyTestsDoNotAlreadyCoverThis: "Stub.",
  suggestedRegressionTest: null,
  minimumFixScope: "Stub.",
  requiresPolicyReview: false,
  upstreamOrigin: null,
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
    const titleMatch =
      /flagged a (?:bug|security|performance|concurrency|api-contract|data-loss|test-gap|docs-gap|build-release|maintainability)[^]*?titled:\s*\n\s+(.+)/u.exec(
        prompt,
      );
    const title = titleMatch?.[1] ?? "";
    const result = await impl(stubFinding({ title }));
    // The provider modules attach the resolved modelId; the test harness
    // synthesizes one so the orchestrator's modelId-threading is exercised.
    return { ...result, modelId: `${name}-test-model` };
  },
});

const buildCountingPatchProviders = () => {
  const calls: string[] = [];
  const providers: PatchProposingProvider[] = ["anthropic", "openai"].map((name) => ({
    name,
    async proposePatch() {
      calls.push(name);
      return {
        patch: "@@ -12,1 +12,1 @@\n-old\n+new\n",
        rationale: null,
        modelId: `${name}-test-model`,
      };
    },
  }));
  return { calls, providers };
};

const baseArgs = (
  overrides: Partial<GenerateReviewPatchesArgs> = {},
): GenerateReviewPatchesArgs => ({
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
  it("calls the provider for file-level findings in changed files as out-of-hunk artifacts", async () => {
    let called = false;
    const provider = buildProvider("anthropic", async () => {
      called = true;
      return {
        patch: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -25,1 +25,1 @@\n-old\n+new\n",
        rationale: "file-level fix",
      };
    });
    const finding = stubFinding({
      evidence: [{ path: "src/foo.ts", startLine: null, endLine: null, symbol: null, quote: null }],
    });
    const result = await generateReviewPatches(
      baseArgs({ findings: [finding], providers: [provider] }),
    );
    expect(result.proposals[0]?.patch).toContain("+new");
    expect(result.proposals[0]?.skipReason).toBeNull();
    expect(called).toBe(true);
  });

  it("emits outside_diff_hunk when evidence path is missing from PR diff", async () => {
    let called = false;
    const provider = buildProvider("anthropic", async () => {
      called = true;
      throw new Error("should not reach provider");
    });
    const finding = stubFinding({
      evidence: [{ path: "src/unknown.ts", startLine: 5, endLine: 5, symbol: null, quote: null }],
    });
    const result = await generateReviewPatches(
      baseArgs({ findings: [finding], providers: [provider] }),
    );
    expect(result.proposals[0]?.skipReason).toBe("outside_diff_hunk");
    expect(called).toBe(false);
  });

  it("calls the provider when evidence is in the same changed file but disjoint from the hunk", async () => {
    let called = false;
    const provider = buildProvider("anthropic", async () => {
      called = true;
      return {
        patch: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -50,1 +50,1 @@\n-old\n+new\n",
        rationale: "out-of-hunk fix",
      };
    });
    const finding = stubFinding({
      // Hunk in stubFile covers lines 1..15 — 50 is well outside.
      evidence: [{ path: "src/foo.ts", startLine: 50, endLine: 52, symbol: null, quote: null }],
    });
    const result = await generateReviewPatches(
      baseArgs({ findings: [finding], providers: [provider] }),
    );
    expect(result.proposals[0]?.patch).toContain("+new");
    expect(result.proposals[0]?.skipReason).toBeNull();
    expect(called).toBe(true);
  });

  it("rejects an out-of-hunk artifact that does not overlap the finding evidence", async () => {
    const provider = buildProvider("anthropic", async () => ({
      patch: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -80,1 +80,1 @@\n-old\n+new\n",
      rationale: "wrong out-of-hunk target",
    }));
    const finding = stubFinding({
      evidence: [{ path: "src/foo.ts", startLine: 50, endLine: 52, symbol: null, quote: null }],
    });
    const result = await generateReviewPatches(
      baseArgs({ findings: [finding], providers: [provider] }),
    );
    expect(result.proposals[0]?.patch).toBeNull();
    expect(result.proposals[0]?.skipReason).toBe("outside_diff_hunk");
    expect(result.proposals[0]?.rationale).toBe("wrong out-of-hunk target");
  });

  it("reaches both providers when evidence is fully contained in a hunk", async () => {
    const { calls, providers } = buildCountingPatchProviders();
    const result = await generateReviewPatches(baseArgs({ providers }));
    expect(calls.toSorted()).toEqual(["anthropic", "openai"]);
    expect(result.proposals).toHaveLength(2);
    expect(result.proposals.every((p) => p.patch?.includes("+new"))).toBe(true);
  });

  it("reaches both providers when evidence partially overlaps a hunk", async () => {
    const { calls, providers } = buildCountingPatchProviders();
    const finding = stubFinding({
      // Hunk in stubFile covers lines 1..15; 12..20 overlaps at 12..15.
      evidence: [{ path: "src/foo.ts", startLine: 12, endLine: 20, symbol: null, quote: null }],
    });
    const result = await generateReviewPatches(baseArgs({ findings: [finding], providers }));
    expect(calls.toSorted()).toEqual(["anthropic", "openai"]);
    expect(result.proposals).toHaveLength(2);
    expect(result.proposals.every((p) => p.patch?.includes("+new"))).toBe(true);
  });

  it("reaches both providers when a hunk is inside a broader evidence range", async () => {
    const { calls, providers } = buildCountingPatchProviders();
    const finding = stubFinding({
      // Hunk in stubFile covers lines 1..15; 1..50 cites a broader block.
      evidence: [{ path: "src/foo.ts", startLine: 1, endLine: 50, symbol: null, quote: null }],
    });
    const result = await generateReviewPatches(baseArgs({ findings: [finding], providers }));
    expect(calls.toSorted()).toEqual(["anthropic", "openai"]);
    expect(result.proposals).toHaveLength(2);
    expect(result.proposals.every((p) => p.patch?.includes("+new"))).toBe(true);
  });

  it("rejects a provider patch whose hunk falls outside the PR diff hunk", async () => {
    const provider = buildProvider("anthropic", async () => ({
      // Evidence overlaps the PR hunk, but this returned patch targets
      // lines outside stubFile's 1..15 hunk and must not ship.
      patch: "@@ -80,1 +80,1 @@\n-old\n+new\n",
      rationale: "bad target",
    }));
    const finding = stubFinding({
      evidence: [{ path: "src/foo.ts", startLine: 1, endLine: 50, symbol: null, quote: null }],
    });
    const result = await generateReviewPatches(
      baseArgs({ findings: [finding], providers: [provider] }),
    );
    expect(result.proposals[0]?.patch).toBeNull();
    expect(result.proposals[0]?.skipReason).toBe("outside_diff_hunk");
    expect(result.proposals[0]?.rationale).toBe("bad target");
  });

  it("rejects a returned multi-hunk patch even when each hunk is inside the PR diff", async () => {
    const provider = buildProvider("anthropic", async () => ({
      patch: "@@ -10,1 +10,1 @@\n-old\n+new\n@@ -12,1 +12,1 @@\n-old2\n+new2\n",
      rationale: "two targets",
    }));
    const result = await generateReviewPatches(baseArgs({ providers: [provider] }));
    expect(result.proposals[0]?.patch).toBeNull();
    expect(result.proposals[0]?.skipReason).toBe("outside_diff_hunk");
    expect(result.proposals[0]?.rationale).toBe("two targets");
  });

  it("rejects a returned patch whose file header targets a different path", async () => {
    const provider = buildProvider("anthropic", async () => ({
      patch: "--- a/src/other.ts\n+++ b/src/other.ts\n@@ -10,1 +10,1 @@\n-old\n+new\n",
      rationale: "wrong file",
    }));
    const result = await generateReviewPatches(baseArgs({ providers: [provider] }));
    expect(result.proposals[0]?.patch).toBeNull();
    expect(result.proposals[0]?.skipReason).toBe("outside_diff_hunk");
    expect(result.proposals[0]?.rationale).toBe("wrong file");
  });

  it("accepts a returned patch whose file header targets the evidence path", async () => {
    const patch = "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -10,1 +10,1 @@\n-old\n+new\n";
    const provider = buildProvider("anthropic", async () => ({
      patch,
      rationale: null,
    }));
    const result = await generateReviewPatches(baseArgs({ providers: [provider] }));
    expect(result.proposals[0]?.patch).toBe(patch);
    expect(result.proposals[0]?.skipReason).toBeNull();
  });

  it("rejects a returned patch hunk that does not overlap the evidence range", async () => {
    const provider = buildProvider("anthropic", async () => ({
      patch: "@@ -14,1 +14,1 @@\n-old\n+new\n",
      rationale: "anchor drift",
    }));
    const finding = stubFinding({
      evidence: [{ path: "src/foo.ts", startLine: 10, endLine: 10, symbol: null, quote: null }],
    });
    const result = await generateReviewPatches(
      baseArgs({ findings: [finding], providers: [provider] }),
    );
    expect(result.proposals[0]?.patch).toBeNull();
    expect(result.proposals[0]?.skipReason).toBe("outside_diff_hunk");
    expect(result.proposals[0]?.rationale).toBe("anchor drift");
  });

  it("accepts a returned patch hunk inside a broader evidence range", async () => {
    const provider = buildProvider("anthropic", async () => ({
      patch: "@@ -14,1 +14,1 @@\n-old\n+new\n",
      rationale: null,
    }));
    const finding = stubFinding({
      evidence: [{ path: "src/foo.ts", startLine: 1, endLine: 50, symbol: null, quote: null }],
    });
    const result = await generateReviewPatches(
      baseArgs({ findings: [finding], providers: [provider] }),
    );
    expect(result.proposals[0]?.patch).toContain("+new");
    expect(result.proposals[0]?.skipReason).toBeNull();
  });

  it("rejects a returned patch with no new-side replacement lines", async () => {
    const provider = buildProvider("anthropic", async () => ({
      patch: "@@ -10,1 +10,1 @@\n old\n",
      rationale: "empty",
    }));
    const result = await generateReviewPatches(baseArgs({ providers: [provider] }));
    expect(result.proposals[0]?.patch).toBeNull();
    expect(result.proposals[0]?.skipReason).toBe("outside_diff_hunk");
    expect(result.proposals[0]?.rationale).toBe("empty");
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
    const result = await generateReviewPatches(
      baseArgs({
        changedFiles: [stubFile({ patch: "@@ -1,40 +1,40 @@\n context\n+added\n" })],
        providers: [provider],
      }),
    );
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
    const result = await generateReviewPatches(baseArgs({ providers: [provider], timeoutMs: 20 }));
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

  it("describes artifact mode when the patch is allowed outside the PR hunk", () => {
    const prompt = buildPatchPrompt(stubFinding(), "artifact");
    expect(prompt).toContain("patch artifact");
    expect(prompt).toContain("outside the PR diff hunk");
    expect(prompt).toContain("non-click-to-apply artifact");
  });

  it("renders '(none provided)' when reproduction is null", () => {
    const prompt = buildPatchPrompt(stubFinding({ reproduction: null }));
    expect(prompt).toContain("(none provided)");
  });
});
