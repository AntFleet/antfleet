import { describe, it, expect } from "vitest";
import { patchSuggestionOutputSchema } from "../types.js";
import { patchSuggestionJsonSchema } from "../provider.js";
import { anthropicProvider } from "./anthropic.js";
import { openaiProvider } from "./openai.js";

// Patch Agent v1.5 — provider-side schema invariants. The live `proposePatch`
// calls are exercised through the orchestrator integration tests; here we
// pin the shape contract so a provider can't silently drift from the gate.

describe("patchSuggestionOutputSchema", () => {
  it("accepts a well-formed unified-diff patch", () => {
    const parsed = patchSuggestionOutputSchema.parse({
      patch:
        "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,1 +1,1 @@\n-const x = 1;\n+const x = 2;\n",
      rationale: "Off-by-one on the counter init.",
    });
    expect(parsed.patch).toContain("@@ -1,1 +1,1 @@");
    expect(parsed.rationale).toContain("counter");
  });

  it("accepts patch=null with non-null rationale (decline path)", () => {
    const parsed = patchSuggestionOutputSchema.parse({
      patch: null,
      rationale: "Fix would touch ≥40 lines across two files; out of v1 scope.",
    });
    expect(parsed.patch).toBeNull();
    expect(parsed.rationale).toMatch(/out of v1 scope/u);
  });

  it("accepts patch=null AND rationale=null (silent decline)", () => {
    const parsed = patchSuggestionOutputSchema.parse({ patch: null, rationale: null });
    expect(parsed.patch).toBeNull();
    expect(parsed.rationale).toBeNull();
  });

  it("rejects missing fields", () => {
    expect(() => patchSuggestionOutputSchema.parse({ patch: null })).toThrow();
    expect(() => patchSuggestionOutputSchema.parse({ rationale: null })).toThrow();
  });

  it("rejects extra fields silently — zod is permissive without strict()", () => {
    // Documents current behavior: extra fields are stripped, not rejected.
    // If a future model returns a `confidence` field, the orchestrator
    // ignores it. Change to .strict() if we want a hard fence.
    const parsed = patchSuggestionOutputSchema.parse({
      patch: null,
      rationale: "ok",
      extra: "ignored",
    });
    expect("extra" in parsed).toBe(false);
  });
});

describe("patchSuggestionJsonSchema (provider-facing strict schema)", () => {
  it("declares both fields required at the JSON-schema layer", () => {
    expect(patchSuggestionJsonSchema.required).toEqual(["patch", "rationale"]);
    expect(patchSuggestionJsonSchema.additionalProperties).toBe(false);
  });

  it("expresses patch + rationale as nullable strings", () => {
    const props = patchSuggestionJsonSchema.properties as Record<string, unknown>;
    expect(props["patch"]).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(props["rationale"]).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
  });
});

describe("providers expose proposePatch", () => {
  it("anthropicProvider implements proposePatch", () => {
    expect(typeof anthropicProvider.proposePatch).toBe("function");
  });

  it("openaiProvider implements proposePatch", () => {
    expect(typeof openaiProvider.proposePatch).toBe("function");
  });
});
