import { describe, it, expect } from "vitest";
import { decidePatchOutcomes, type ProviderPatchProposal } from "./patch-gate.js";

const PATCH_A = "@@ -10,1 +10,1 @@\n-old\n+new\n";
const PATCH_B = "@@ -10,1 +10,1 @@\n-old\n+different\n";

const anthropic = (overrides: Partial<ProviderPatchProposal> = {}): ProviderPatchProposal => ({
  providerName: "anthropic",
  findingId: "fid-1",
  patch: null,
  modelId: "claude-opus-4-7",
  skipReason: null,
  rationale: null,
  usage: null,
  ...overrides,
});

const openai = (overrides: Partial<ProviderPatchProposal> = {}): ProviderPatchProposal => ({
  providerName: "openai",
  findingId: "fid-1",
  patch: null,
  modelId: "gpt-5",
  skipReason: null,
  rationale: null,
  usage: null,
  ...overrides,
});

describe("decidePatchOutcomes — the four spec cases", () => {
  it("both propose → ships anthropic's patch", () => {
    const out = decidePatchOutcomes([anthropic({ patch: PATCH_A }), openai({ patch: PATCH_B })]);
    expect(out).toHaveLength(1);
    expect(out[0]?.patch).toBe(PATCH_A);
    expect(out[0]?.modelId).toBe("claude-opus-4-7");
    expect(out[0]?.skipReason).toBeNull();
    expect(out[0]?.candidates).toEqual({ opus: PATCH_A, gpt5: PATCH_B });
    expect(out[0]?.skipReasons).toEqual({ opus: null, gpt5: null });
    expect(out[0]?.selector).toBe("deterministic-opus");
  });

  it("only anthropic proposes → models_disagreed (findings-only)", () => {
    const out = decidePatchOutcomes([
      anthropic({ patch: PATCH_A, rationale: "fixes the branch" }),
      openai({ patch: null, rationale: "no in-hunk safe fix" }),
    ]);
    expect(out[0]?.patch).toBeNull();
    expect(out[0]?.skipReason).toBe("models_disagreed");
    expect(out[0]?.candidates).toEqual({ opus: PATCH_A, gpt5: null });
    expect(out[0]?.rationales).toEqual({
      opus: "fixes the branch",
      gpt5: "no in-hunk safe fix",
    });
    expect(out[0]?.skipReasons).toEqual({ opus: null, gpt5: null });
    expect(out[0]?.selector).toBe("no-gpt5-deterministic-skip");
  });

  it("only openai proposes → models_disagreed (findings-only)", () => {
    const out = decidePatchOutcomes([anthropic({ patch: null }), openai({ patch: PATCH_B })]);
    expect(out[0]?.patch).toBeNull();
    expect(out[0]?.skipReason).toBe("models_disagreed");
    expect(out[0]?.candidates).toEqual({ opus: null, gpt5: PATCH_B });
    expect(out[0]?.skipReasons).toEqual({ opus: null, gpt5: null });
    expect(out[0]?.selector).toBe("no-opus-deterministic-skip");
  });

  it("neither proposes (both clean declines) → models_disagreed", () => {
    const out = decidePatchOutcomes([anthropic({ patch: null }), openai({ patch: null })]);
    expect(out[0]?.patch).toBeNull();
    expect(out[0]?.skipReason).toBe("models_disagreed");
    expect(out[0]?.candidates).toEqual({ opus: null, gpt5: null });
    expect(out[0]?.skipReasons).toEqual({ opus: null, gpt5: null });
    expect(out[0]?.selector).toBe("no-candidates");
  });
});

describe("decidePatchOutcomes — shipping behavior regression", () => {
  it("shipped patch is byte-identical to pre-refactor output (both propose)", () => {
    const out = decidePatchOutcomes([anthropic({ patch: PATCH_A }), openai({ patch: PATCH_B })]);
    // Pre-refactor: returned { patch: PATCH_A, modelId: 'claude-opus-4-7', skipReason: null }
    expect(out[0]?.patch).toBe(PATCH_A);
    expect(out[0]?.modelId).toBe("claude-opus-4-7");
    expect(out[0]?.skipReason).toBeNull();
  });

  it("shipped patch is null when only anthropic proposes (pre-refactor behavior)", () => {
    const out = decidePatchOutcomes([anthropic({ patch: PATCH_A }), openai({ patch: null })]);
    expect(out[0]?.patch).toBeNull();
  });

  it("shipped patch is null when only openai proposes (pre-refactor behavior)", () => {
    const out = decidePatchOutcomes([anthropic({ patch: null }), openai({ patch: PATCH_B })]);
    expect(out[0]?.patch).toBeNull();
  });

  it("shipped patch is null when neither proposes (pre-refactor behavior)", () => {
    const out = decidePatchOutcomes([anthropic({ patch: null }), openai({ patch: null })]);
    expect(out[0]?.patch).toBeNull();
  });
});

describe("decidePatchOutcomes — skip-reason surfacing", () => {
  it("preserves the shared reason when both providers skipped for the same cause", () => {
    const out = decidePatchOutcomes([
      anthropic({ skipReason: "outside_diff_hunk" }),
      openai({ skipReason: "outside_diff_hunk" }),
    ]);
    expect(out[0]?.skipReason).toBe("outside_diff_hunk");
    expect(out[0]?.selector).toBe("no-candidates");
  });

  it("prioritizes generation_error when any provider errored", () => {
    const out = decidePatchOutcomes([
      anthropic({ skipReason: "generation_error" }),
      openai({ skipReason: "outside_diff_hunk" }),
    ]);
    expect(out[0]?.skipReason).toBe("generation_error");
  });

  it("prioritizes size_cap over outside_diff_hunk", () => {
    const out = decidePatchOutcomes([
      anthropic({ skipReason: "size_cap" }),
      openai({ skipReason: "outside_diff_hunk" }),
    ]);
    expect(out[0]?.skipReason).toBe("size_cap");
  });

  it("falls back to models_disagreed when reasons mix in ways the priority doesn't cover", () => {
    const out = decidePatchOutcomes([
      anthropic({ skipReason: "disabled" }),
      openai({ skipReason: "models_disagreed" }),
    ]);
    expect(out[0]?.skipReason).toBe("disabled");
  });
});

describe("decidePatchOutcomes — disagreement keeps the loser's reason out", () => {
  it("anthropic proposes but openai hit size_cap → models_disagreed (not size_cap)", () => {
    // Spec: any one-sided proposal is `models_disagreed`. We don't escalate
    // the structural reason here — the agreement signal is what matters.
    const out = decidePatchOutcomes([
      anthropic({ patch: PATCH_A }),
      openai({ skipReason: "size_cap" }),
    ]);
    expect(out[0]?.patch).toBeNull();
    expect(out[0]?.skipReason).toBe("models_disagreed");
    expect(out[0]?.candidates).toEqual({ opus: PATCH_A, gpt5: null });
    expect(out[0]?.skipReasons).toEqual({ opus: null, gpt5: "size_cap" });
    expect(out[0]?.selector).toBe("no-gpt5-deterministic-skip");
  });

  it("propagates per-side skipReason: opus shipped, gpt5 generation_error", () => {
    const out = decidePatchOutcomes([
      anthropic({ patch: PATCH_A, skipReason: null }),
      openai({ patch: null, skipReason: "generation_error" }),
    ]);
    expect(out[0]?.patch).toBeNull();
    expect(out[0]?.skipReason).toBe("models_disagreed");
    expect(out[0]?.skipReasons).toEqual({ opus: null, gpt5: "generation_error" });
    expect(out[0]?.selector).toBe("no-gpt5-deterministic-skip");
  });

  it("propagates per-side skipReason: gpt5 shipped, opus generation_error", () => {
    const out = decidePatchOutcomes([
      anthropic({ patch: null, skipReason: "generation_error" }),
      openai({ patch: PATCH_B, skipReason: null }),
    ]);
    expect(out[0]?.patch).toBeNull();
    expect(out[0]?.skipReason).toBe("models_disagreed");
    expect(out[0]?.skipReasons).toEqual({ opus: "generation_error", gpt5: null });
    expect(out[0]?.selector).toBe("no-opus-deterministic-skip");
  });
});

describe("decidePatchOutcomes — multi-finding fan-out", () => {
  it("groups proposals by findingId and emits one decision each", () => {
    const out = decidePatchOutcomes([
      anthropic({ findingId: "fid-A", patch: PATCH_A }),
      openai({ findingId: "fid-A", patch: PATCH_B }),
      anthropic({ findingId: "fid-B", skipReason: "outside_diff_hunk" }),
      openai({ findingId: "fid-B", skipReason: "outside_diff_hunk" }),
      anthropic({ findingId: "fid-C", patch: PATCH_A }),
      openai({ findingId: "fid-C", patch: null }),
    ]);
    expect(out).toHaveLength(3);
    const byId = new Map(out.map((d) => [d.findingId, d]));
    expect(byId.get("fid-A")?.patch).toBe(PATCH_A);
    expect(byId.get("fid-A")?.selector).toBe("deterministic-opus");
    expect(byId.get("fid-B")?.skipReason).toBe("outside_diff_hunk");
    expect(byId.get("fid-B")?.selector).toBe("no-candidates");
    expect(byId.get("fid-C")?.skipReason).toBe("models_disagreed");
    expect(byId.get("fid-C")?.selector).toBe("no-gpt5-deterministic-skip");
  });

  it("emits stable findingId-sorted output", () => {
    const out = decidePatchOutcomes([
      anthropic({ findingId: "fid-Z", patch: null }),
      openai({ findingId: "fid-Z", patch: null }),
      anthropic({ findingId: "fid-A", patch: null }),
      openai({ findingId: "fid-A", patch: null }),
    ]);
    expect(out.map((d) => d.findingId)).toEqual(["fid-A", "fid-Z"]);
  });
});

describe("decidePatchOutcomes — degenerate inputs", () => {
  it("returns [] for empty input", () => {
    expect(decidePatchOutcomes([])).toEqual([]);
  });

  it("treats a single-provider-only group as models_disagreed even when that provider proposed", () => {
    // A future stack with just one provider would always be 'agreement of
    // one' — the gate refuses to ship through. PR3's contract is that
    // BOTH providers must propose.
    const out = decidePatchOutcomes([anthropic({ patch: PATCH_A })]);
    expect(out[0]?.patch).toBeNull();
    expect(out[0]?.skipReason).toBe("models_disagreed");
    expect(out[0]?.candidates).toEqual({ opus: PATCH_A, gpt5: null });
    expect(out[0]?.skipReasons).toEqual({ opus: null, gpt5: null });
  });

  it("ships when more than two providers exist as long as anthropic + ONE other propose", () => {
    const third: ProviderPatchProposal = {
      providerName: "openrouter",
      findingId: "fid-1",
      patch: null,
      modelId: null,
      skipReason: "outside_diff_hunk",
      rationale: null,
      usage: null,
    };
    const out = decidePatchOutcomes([
      anthropic({ patch: PATCH_A }),
      openai({ patch: PATCH_B }),
      third,
    ]);
    expect(out[0]?.patch).toBe(PATCH_A);
    expect(out[0]?.skipReason).toBeNull();
    expect(out[0]?.selector).toBe("deterministic-opus");
  });
});

describe("decidePatchOutcomes — modelId threading (audit-response)", () => {
  it("uses the modelId reported by the winning anthropic proposal, not a captured constant", () => {
    // Future anthropic upgrade scenario: the provider's resolved model
    // for this call is claude-opus-4-8 (not the module-load default).
    // The gate must record that, not the const.
    const out = decidePatchOutcomes([
      anthropic({ patch: PATCH_A, modelId: "claude-opus-4-8" }),
      openai({ patch: PATCH_B, modelId: "gpt-6" }),
    ]);
    expect(out[0]?.modelId).toBe("claude-opus-4-8");
  });

  it("falls back to provider name when modelId is unexpectedly null", () => {
    const out = decidePatchOutcomes([
      anthropic({ patch: PATCH_A, modelId: null }),
      openai({ patch: PATCH_B, modelId: "gpt-5" }),
    ]);
    expect(out[0]?.modelId).toBe("anthropic");
  });
});

describe("decidePatchOutcomes — idempotence", () => {
  it("running twice on the same input yields identical output", () => {
    const input = [
      anthropic({ patch: PATCH_A }),
      openai({ patch: PATCH_B }),
      anthropic({ findingId: "fid-2", skipReason: "outside_diff_hunk" }),
      openai({ findingId: "fid-2", skipReason: "outside_diff_hunk" }),
    ];
    const a = decidePatchOutcomes(input);
    const b = decidePatchOutcomes(input);
    expect(a).toEqual(b);
  });
});
