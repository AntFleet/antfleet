import { describe, it, expect } from "vitest";
import {
  generateReviewPatches,
  PATCH_SIZE_LINE_CAP,
  buildPatchPrompt,
  extractSourceWindow,
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
  label: "blocking",
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

// Real source of src/foo.ts. The apply-floor (normalizePatchForApply) locates
// each proposed patch's old-side block inside this content and refuses to ship
// a patch whose old-side isn't present. The suite's mock patches edit the
// `old` / `old2` / `different` lines, so those must exist here verbatim.
const STUB_FILE_CONTENTS = "const a = 1;\nold\nold2\ndifferent\nline-a\nline-b\nline-c\n";

const stubFile = (overrides: Partial<ChangedFile> = {}): ChangedFile => ({
  filename: "src/foo.ts",
  contents: STUB_FILE_CONTENTS,
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
        // Full unified diff (with --- / +++ headers) so the apply-floor's
        // parser can read the path and anchor the old-side `old` against
        // STUB_FILE_CONTENTS.
        patch: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -12,1 +12,1 @@\n-old\n+new\n",
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
      patch: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -10,1 +10,1 @@\n-old\n+new\n",
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
    // Old-side `old` exists in STUB_FILE_CONTENTS, so the apply-floor locates
    // it and ships. The shipped patch is the adapter's re-anchored form (a
    // clean `diff --git` envelope), so we assert on its content, not byte
    // identity with the raw model output.
    const patch = "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -10,1 +10,1 @@\n-old\n+new\n";
    const provider = buildProvider("anthropic", async () => ({
      patch,
      rationale: null,
    }));
    const result = await generateReviewPatches(baseArgs({ providers: [provider] }));
    expect(result.proposals[0]?.patch).toContain("-old");
    expect(result.proposals[0]?.patch).toContain("+new");
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
      patch: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -14,1 +14,1 @@\n-old\n+new\n",
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
    // 20 added lines (exactly at the cap) plus one old-side line (`old`,
    // present in STUB_FILE_CONTENTS) so the apply-floor can anchor it. The
    // count of ADDED lines is what the cap measures — the single `-old` does
    // not count against it.
    const cappedPatch =
      "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -10,1 +10,20 @@\n-old\n" +
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
    // Shipped patch is the apply-floor's re-anchored form; assert content and
    // that the full added-line set survived, rather than byte identity.
    expect(result.proposals[0]?.patch).toContain("+l0");
    expect(result.proposals[0]?.patch).toContain(`+l${PATCH_SIZE_LINE_CAP - 1}`);
    expect(result.proposals[0]?.skipReason).toBeNull();
  });
});

describe("generateReviewPatches — apply-floor", () => {
  // Real source of the changed file. The provider patches below either match
  // this old-side (ships) or hallucinate a block that isn't here (rejected).
  const REAL_CONTENTS =
    "export function key(parts: string[]): string {\n  return parts.join('|');\n}\n";
  const realFile = stubFile({ filename: "src/key.ts", contents: REAL_CONTENTS });
  const findingInKeyFile = stubFinding({
    evidence: [{ path: "src/key.ts", startLine: 2, endLine: 2, symbol: "key", quote: null }],
  });
  // stubFile's default hunk covers 1..15; a patch targeting line 2 lands
  // inside it, so it passes the targeting check and reaches the apply-floor.
  const keyFileArgs = {
    changedFiles: [realFile],
    findings: [findingInKeyFile],
  };

  it("rejects a patch whose old-side does NOT match the real file (hallucinated context)", async () => {
    // The real function is `return parts.join('|');`, but the model proposes a
    // patch editing a `JSON.stringify({...})` block that does not exist in the
    // source. It would fail `git apply` (exit 128); the floor catches it.
    const provider = buildProvider("anthropic", async () => ({
      patch:
        "--- a/src/key.ts\n+++ b/src/key.ts\n@@ -2,1 +2,1 @@\n" +
        "-  return JSON.stringify({ parts });\n" +
        "+  return parts.join('::');\n",
      rationale: "swap delimiter",
    }));
    const result = await generateReviewPatches(baseArgs({ ...keyFileArgs, providers: [provider] }));
    expect(result.proposals[0]?.patch).toBeNull();
    expect(result.proposals[0]?.skipReason).toBe("patch_apply_failed");
    expect(result.proposals[0]?.rationale).toBe("swap delimiter");
    expect(result.proposals[0]?.modelId).toBe("anthropic-test-model");
  });

  it("ships a patch whose old-side matches the real file", async () => {
    const provider = buildProvider("anthropic", async () => ({
      patch:
        "--- a/src/key.ts\n+++ b/src/key.ts\n@@ -2,1 +2,1 @@\n" +
        "-  return parts.join('|');\n+  return parts.join('::');\n",
      rationale: null,
    }));
    const result = await generateReviewPatches(baseArgs({ ...keyFileArgs, providers: [provider] }));
    expect(result.proposals[0]?.patch).not.toBeNull();
    expect(result.proposals[0]?.skipReason).toBeNull();
    expect(result.proposals[0]?.patch).toContain("+  return parts.join('::');");
  });

  it("ships the NORMALIZED (re-anchored) patch for a malformed-but-locatable diff", async () => {
    // Malformed: the old-side line is present and the hunk header's start line
    // (2) lands inside the PR hunk so targeting passes, but the diff lacks a
    // `diff --git` header and its hunk counts drift (says ,9 with only one
    // -/+ line). git apply would reject the raw shape. The old-side still
    // locates in the real file, so the floor re-anchors and ships a clean,
    // git-appliable diff that differs from the raw model output.
    const raw =
      "--- a/src/key.ts\n+++ b/src/key.ts\n@@ -2,9 +2,9 @@\n" +
      "-  return parts.join('|');\n+  return parts.join('::');\n";
    const provider = buildProvider("anthropic", async () => ({ patch: raw, rationale: null }));
    const result = await generateReviewPatches(baseArgs({ ...keyFileArgs, providers: [provider] }));
    const shipped = result.proposals[0]?.patch;
    expect(shipped).not.toBeNull();
    expect(result.proposals[0]?.skipReason).toBeNull();
    // Re-anchored: carries a proper diff --git envelope and the true count
    // (,1) header, not the raw model's drifting @@ -2,9 header.
    expect(shipped).not.toBe(raw);
    expect(shipped).toContain("diff --git a/src/key.ts b/src/key.ts");
    expect(shipped).toContain("@@ -2,1 +2,1 @@");
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
        return {
          patch: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -10,1 +10,1 @@\n-old\n+new\n",
          rationale: null,
          modelId: "stub-model",
        };
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

  it("rule forbids describing the patch as a decline rationale", () => {
    const prompt = buildPatchPrompt(stubFinding());
    expect(prompt).toContain("WHY a patch is impossible");
    expect(prompt).toContain("MUST NOT");
    expect(prompt).toContain("describe what the patch would do");
  });

  it("embeds the real SOURCE window and a verbatim-copy rule when given an excerpt", () => {
    const excerpt = { text: "const x = 1;\nconst y = 2;", firstLine: 8 };
    const prompt = buildPatchPrompt(stubFinding(), "inline", excerpt);
    expect(prompt).toContain("SOURCE — exact current contents");
    expect(prompt).toContain("starting at line 8");
    expect(prompt).toContain("const x = 1;");
    expect(prompt).toContain("VERBATIM");
    expect(prompt).toContain("Do not invent surrounding code");
  });

  it("tells the model to decline when no source is shown", () => {
    const prompt = buildPatchPrompt(stubFinding(), "inline", null);
    expect(prompt).toContain("source not shown");
    expect(prompt).not.toContain("SOURCE — exact current contents");
  });
});

describe("extractSourceWindow", () => {
  const file = Array.from({ length: 200 }, (_v, i) => `line ${i + 1}`).join("\n");

  it("windows ±40 lines around the evidence and reports the first line", () => {
    const w = extractSourceWindow(file, 100, 100);
    expect(w).not.toBeNull();
    expect(w?.firstLine).toBe(60);
    expect(w?.text).toContain("line 60");
    expect(w?.text).toContain("line 100");
    expect(w?.text).toContain("line 140");
    expect(w?.text).not.toContain("line 59\n");
  });

  it("clamps the window to the file bounds", () => {
    const w = extractSourceWindow(file, 5, 5);
    expect(w?.firstLine).toBe(1);
    expect(w?.text.startsWith("line 1")).toBe(true);
  });

  it("returns null for empty contents", () => {
    expect(extractSourceWindow("", 10, 12)).toBeNull();
  });
});
