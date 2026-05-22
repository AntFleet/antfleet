import { describe, it, expect } from "vitest";
import {
  decidePatchOutcomes,
  type ProviderPatchProposal,
} from "./patch-gate.js";

const PATCH_A = "@@ -10,1 +10,1 @@\n-old\n+new\n";
const PATCH_B = "@@ -10,1 +10,1 @@\n-old\n+different\n";

const anthropic = (
  overrides: Partial<ProviderPatchProposal> = {},
): ProviderPatchProposal => ({
  providerName: "anthropic",
  findingId: "fid-1",
  patch: null,
  skipReason: null,
  rationale: null,
  ...overrides,
});

const openai = (
  overrides: Partial<ProviderPatchProposal> = {},
): ProviderPatchProposal => ({
  providerName: "openai",
  findingId: "fid-1",
  patch: null,
  skipReason: null,
  rationale: null,
  ...overrides,
});

describe("decidePatchOutcomes — the four spec cases", () => {
  it("both propose → ships anthropic's patch", () => {
    const out = decidePatchOutcomes([
      anthropic({ patch: PATCH_A }),
      openai({ patch: PATCH_B }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.patch).toBe(PATCH_A);
    expect(out[0]?.modelId).toBe("claude-opus-4-7");
    expect(out[0]?.skipReason).toBeNull();
  });

  it("only anthropic proposes → models_disagreed (findings-only)", () => {
    const out = decidePatchOutcomes([
      anthropic({ patch: PATCH_A }),
      openai({ patch: null }),
    ]);
    expect(out[0]?.patch).toBeNull();
    expect(out[0]?.skipReason).toBe("models_disagreed");
  });

  it("only openai proposes → models_disagreed (findings-only)", () => {
    const out = decidePatchOutcomes([
      anthropic({ patch: null }),
      openai({ patch: PATCH_B }),
    ]);
    expect(out[0]?.patch).toBeNull();
    expect(out[0]?.skipReason).toBe("models_disagreed");
  });

  it("neither proposes (both clean declines) → models_disagreed", () => {
    const out = decidePatchOutcomes([
      anthropic({ patch: null }),
      openai({ patch: null }),
    ]);
    expect(out[0]?.patch).toBeNull();
    expect(out[0]?.skipReason).toBe("models_disagreed");
  });
});

describe("decidePatchOutcomes — skip-reason surfacing", () => {
  it("preserves the shared reason when both providers skipped for the same cause", () => {
    const out = decidePatchOutcomes([
      anthropic({ skipReason: "outside_diff_hunk" }),
      openai({ skipReason: "outside_diff_hunk" }),
    ]);
    expect(out[0]?.skipReason).toBe("outside_diff_hunk");
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
    expect(byId.get("fid-B")?.skipReason).toBe("outside_diff_hunk");
    expect(byId.get("fid-C")?.skipReason).toBe("models_disagreed");
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
  });

  it("ships when more than two providers exist as long as anthropic + ONE other propose", () => {
    const third: ProviderPatchProposal = {
      providerName: "openrouter",
      findingId: "fid-1",
      patch: null,
      skipReason: "outside_diff_hunk",
      rationale: null,
    };
    const out = decidePatchOutcomes([
      anthropic({ patch: PATCH_A }),
      openai({ patch: PATCH_B }),
      third,
    ]);
    expect(out[0]?.patch).toBe(PATCH_A);
    expect(out[0]?.skipReason).toBeNull();
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
