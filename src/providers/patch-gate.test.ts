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
  modelId: "gpt-5.5",
  skipReason: null,
  rationale: null,
  usage: null,
  ...overrides,
});

describe("decidePatchOutcomes — the four spec cases", () => {
  it("both propose → ships anthropic's patch (confidence unanimous)", () => {
    const out = decidePatchOutcomes([anthropic({ patch: PATCH_A }), openai({ patch: PATCH_B })]);
    expect(out).toHaveLength(1);
    expect(out[0]?.patch).toBe(PATCH_A);
    expect(out[0]?.modelId).toBe("claude-opus-4-7");
    expect(out[0]?.gateOutcome).toBeNull();
    expect(out[0]?.confidence).toBe("unanimous");
    expect(out[0]?.candidates).toEqual({ opus: PATCH_A, gpt5: PATCH_B });
    expect(out[0]?.skipReasons).toEqual({ opus: null, gpt5: null });
    expect(out[0]?.selector).toBe("deterministic-opus");
  });

  it("only anthropic proposes → ships opus patch as single_model", () => {
    const out = decidePatchOutcomes([
      anthropic({ patch: PATCH_A, rationale: "fixes the branch" }),
      openai({ patch: null, rationale: "no in-hunk safe fix" }),
    ]);
    // v2 inversion: a lone valid Opus patch now ships; the verifier is the
    // gate, and confidence flags it as single_model (unverified consensus).
    expect(out[0]?.patch).toBe(PATCH_A);
    expect(out[0]?.modelId).toBe("claude-opus-4-7");
    expect(out[0]?.gateOutcome).toBeNull();
    expect(out[0]?.confidence).toBe("single_model");
    expect(out[0]?.candidates).toEqual({ opus: PATCH_A, gpt5: null });
    expect(out[0]?.rationales).toEqual({
      opus: "fixes the branch",
      gpt5: "no in-hunk safe fix",
    });
    expect(out[0]?.skipReasons).toEqual({ opus: null, gpt5: null });
    expect(out[0]?.selector).toBe("no-gpt5-deterministic-skip");
  });

  it("only openai proposes → ships gpt5 patch as single_model", () => {
    const out = decidePatchOutcomes([anthropic({ patch: null }), openai({ patch: PATCH_B })]);
    expect(out[0]?.patch).toBe(PATCH_B);
    expect(out[0]?.modelId).toBe("gpt-5.5");
    expect(out[0]?.gateOutcome).toBeNull();
    expect(out[0]?.confidence).toBe("single_model");
    expect(out[0]?.candidates).toEqual({ opus: null, gpt5: PATCH_B });
    expect(out[0]?.skipReasons).toEqual({ opus: null, gpt5: null });
    expect(out[0]?.selector).toBe("no-opus-deterministic-skip");
  });

  it("neither proposes (both clean declines) → models_disagreed, no patch", () => {
    const out = decidePatchOutcomes([anthropic({ patch: null }), openai({ patch: null })]);
    expect(out[0]?.patch).toBeNull();
    expect(out[0]?.gateOutcome).toBe("models_disagreed");
    expect(out[0]?.confidence).toBeNull();
    expect(out[0]?.candidates).toEqual({ opus: null, gpt5: null });
    expect(out[0]?.skipReasons).toEqual({ opus: null, gpt5: null });
    expect(out[0]?.selector).toBe("no-candidates");
  });
});

describe("decidePatchOutcomes — shipping behavior (verifier-first)", () => {
  it("both-propose still ships the anthropic patch unchanged", () => {
    const out = decidePatchOutcomes([anthropic({ patch: PATCH_A }), openai({ patch: PATCH_B })]);
    expect(out[0]?.patch).toBe(PATCH_A);
    expect(out[0]?.modelId).toBe("claude-opus-4-7");
    expect(out[0]?.gateOutcome).toBeNull();
    expect(out[0]?.confidence).toBe("unanimous");
  });

  it("ships the opus patch when only anthropic proposes (single_model)", () => {
    const out = decidePatchOutcomes([anthropic({ patch: PATCH_A }), openai({ patch: null })]);
    expect(out[0]?.patch).toBe(PATCH_A);
    expect(out[0]?.confidence).toBe("single_model");
  });

  it("ships the gpt5 patch when only openai proposes (single_model)", () => {
    const out = decidePatchOutcomes([anthropic({ patch: null }), openai({ patch: PATCH_B })]);
    expect(out[0]?.patch).toBe(PATCH_B);
    expect(out[0]?.confidence).toBe("single_model");
  });

  it("ships no patch when neither proposes", () => {
    const out = decidePatchOutcomes([anthropic({ patch: null }), openai({ patch: null })]);
    expect(out[0]?.patch).toBeNull();
    expect(out[0]?.confidence).toBeNull();
  });
});

describe("decidePatchOutcomes — skip-reason surfacing", () => {
  it("preserves the shared reason when both providers skipped for the same cause", () => {
    const out = decidePatchOutcomes([
      anthropic({ skipReason: "outside_diff_hunk" }),
      openai({ skipReason: "outside_diff_hunk" }),
    ]);
    expect(out[0]?.gateOutcome).toBe("outside_diff_hunk");
    expect(out[0]?.selector).toBe("no-candidates");
  });

  it("prioritizes generation_error when any provider errored", () => {
    const out = decidePatchOutcomes([
      anthropic({ skipReason: "generation_error" }),
      openai({ skipReason: "outside_diff_hunk" }),
    ]);
    expect(out[0]?.gateOutcome).toBe("generation_error");
  });

  it("prioritizes size_cap over outside_diff_hunk", () => {
    const out = decidePatchOutcomes([
      anthropic({ skipReason: "size_cap" }),
      openai({ skipReason: "outside_diff_hunk" }),
    ]);
    expect(out[0]?.gateOutcome).toBe("size_cap");
  });

  it("both providers hit patch_apply_failed → gateOutcome patch_apply_failed, no patch", () => {
    const out = decidePatchOutcomes([
      anthropic({ patch: null, skipReason: "patch_apply_failed" }),
      openai({ patch: null, skipReason: "patch_apply_failed" }),
    ]);
    expect(out[0]?.patch).toBeNull();
    expect(out[0]?.gateOutcome).toBe("patch_apply_failed");
    expect(out[0]?.confidence).toBeNull();
    expect(out[0]?.selector).toBe("no-candidates");
    expect(out[0]?.skipReasons).toEqual({
      opus: "patch_apply_failed",
      gpt5: "patch_apply_failed",
    });
  });

  it("prioritizes generation_error over patch_apply_failed", () => {
    const out = decidePatchOutcomes([
      anthropic({ skipReason: "generation_error" }),
      openai({ skipReason: "patch_apply_failed" }),
    ]);
    expect(out[0]?.gateOutcome).toBe("generation_error");
  });

  it("prioritizes patch_apply_failed over size_cap", () => {
    const out = decidePatchOutcomes([
      anthropic({ skipReason: "patch_apply_failed" }),
      openai({ skipReason: "size_cap" }),
    ]);
    expect(out[0]?.gateOutcome).toBe("patch_apply_failed");
  });

  it("falls back to models_disagreed when reasons mix in ways the priority doesn't cover", () => {
    const out = decidePatchOutcomes([
      anthropic({ skipReason: "disabled" }),
      openai({ skipReason: "models_disagreed" }),
    ]);
    expect(out[0]?.gateOutcome).toBe("disabled");
  });
});

describe("decidePatchOutcomes — one-sided ships, loser's reason surfaced per-side", () => {
  it("anthropic proposes but openai hit size_cap → ships opus (single_model), keeps per-side reason", () => {
    // v2: the lone valid Opus patch ships; the verifier gates. The declining
    // side's structural reason stays in the per-side skipReasons for
    // observability but no longer nulls the shipment.
    const out = decidePatchOutcomes([
      anthropic({ patch: PATCH_A }),
      openai({ skipReason: "size_cap" }),
    ]);
    expect(out[0]?.patch).toBe(PATCH_A);
    expect(out[0]?.gateOutcome).toBeNull();
    expect(out[0]?.confidence).toBe("single_model");
    expect(out[0]?.candidates).toEqual({ opus: PATCH_A, gpt5: null });
    expect(out[0]?.skipReasons).toEqual({ opus: null, gpt5: "size_cap" });
    expect(out[0]?.selector).toBe("no-gpt5-deterministic-skip");
  });

  it("propagates per-side skipReason: opus shipped single_model, gpt5 generation_error", () => {
    const out = decidePatchOutcomes([
      anthropic({ patch: PATCH_A, skipReason: null }),
      openai({ patch: null, skipReason: "generation_error" }),
    ]);
    expect(out[0]?.patch).toBe(PATCH_A);
    expect(out[0]?.gateOutcome).toBeNull();
    expect(out[0]?.confidence).toBe("single_model");
    expect(out[0]?.skipReasons).toEqual({ opus: null, gpt5: "generation_error" });
    expect(out[0]?.selector).toBe("no-gpt5-deterministic-skip");
  });

  it("propagates per-side skipReason: gpt5 shipped single_model, opus generation_error", () => {
    const out = decidePatchOutcomes([
      anthropic({ patch: null, skipReason: "generation_error" }),
      openai({ patch: PATCH_B, skipReason: null }),
    ]);
    expect(out[0]?.patch).toBe(PATCH_B);
    expect(out[0]?.gateOutcome).toBeNull();
    expect(out[0]?.confidence).toBe("single_model");
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
    expect(byId.get("fid-B")?.gateOutcome).toBe("outside_diff_hunk");
    expect(byId.get("fid-B")?.selector).toBe("no-candidates");
    // fid-C: only anthropic proposed → ships opus as single_model.
    expect(byId.get("fid-C")?.patch).toBe(PATCH_A);
    expect(byId.get("fid-C")?.gateOutcome).toBeNull();
    expect(byId.get("fid-C")?.confidence).toBe("single_model");
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

  it("ships a single-provider-only group as single_model (verifier gates it)", () => {
    // v2: a lone valid patch ships regardless of how many providers were in
    // the group — the deterministic verifier is the gate, not consensus.
    const out = decidePatchOutcomes([anthropic({ patch: PATCH_A })]);
    expect(out[0]?.patch).toBe(PATCH_A);
    expect(out[0]?.gateOutcome).toBeNull();
    expect(out[0]?.confidence).toBe("single_model");
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
    expect(out[0]?.gateOutcome).toBeNull();
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
      openai({ patch: PATCH_B, modelId: "gpt-5.5" }),
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

const virtual = (overrides: Partial<ProviderPatchProposal> = {}): ProviderPatchProposal => ({
  providerName: "openrouter",
  findingId: "fid-1",
  patch: null,
  modelId: "meta-llama/llama-4-maverick",
  skipReason: null,
  rationale: null,
  usage: null,
  ...overrides,
});

describe("decidePatchOutcomes — provider-keyed candidates (T3.8c)", () => {
  it("captures a virtual (non-openai) provider's patch in candidates.gpt5 slot when both propose", () => {
    const out = decidePatchOutcomes([anthropic({ patch: PATCH_A }), virtual({ patch: PATCH_B })]);
    expect(out[0]?.patch).toBe(PATCH_A);
    expect(out[0]?.gateOutcome).toBeNull();
    expect(out[0]?.selector).toBe("deterministic-opus");
    // The virtual provider's patch must be captured — not null — in gpt5 slot.
    expect(out[0]?.candidates).toEqual({ opus: PATCH_A, gpt5: PATCH_B });
    expect(out[0]?.skipReasons).toEqual({ opus: null, gpt5: null });
  });

  it("captures a virtual provider's skipReason in skipReasons.gpt5 slot when it declined", () => {
    const out = decidePatchOutcomes([
      anthropic({ patch: PATCH_A }),
      virtual({ patch: null, skipReason: "outside_diff_hunk" }),
    ]);
    // v2: opus's lone patch ships single_model; the declining virtual side's
    // reason still lands in the gpt5 slot for observability.
    expect(out[0]?.patch).toBe(PATCH_A);
    expect(out[0]?.gateOutcome).toBeNull();
    expect(out[0]?.confidence).toBe("single_model");
    expect(out[0]?.candidates).toEqual({ opus: PATCH_A, gpt5: null });
    expect(out[0]?.skipReasons).toEqual({ opus: null, gpt5: "outside_diff_hunk" });
    expect(out[0]?.selector).toBe("no-gpt5-deterministic-skip");
  });

  it("captures a virtual provider's rationale in rationales.gpt5 slot", () => {
    const out = decidePatchOutcomes([
      anthropic({ patch: null, rationale: "no safe fix available" }),
      virtual({ patch: null, rationale: "out of scope" }),
    ]);
    expect(out[0]?.rationales).toEqual({
      opus: "no safe fix available",
      gpt5: "out of scope",
    });
  });

  it("gpt5 candidate slots stay null when only anthropic is in the group (pre-existing behavior unchanged)", () => {
    const out = decidePatchOutcomes([anthropic({ patch: PATCH_A })]);
    expect(out[0]?.candidates).toEqual({ opus: PATCH_A, gpt5: null });
    expect(out[0]?.skipReasons).toEqual({ opus: null, gpt5: null });
  });
});
