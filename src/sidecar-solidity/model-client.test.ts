import { describe, it, expect } from "vitest";
import { handleToolResponse, normalizeToolInput, unwrapNestedToolInput } from "./model-client.js";

describe("handleToolResponse — truncation safety (item 5)", () => {
  it("marks truncated=true when stop_reason is max_tokens (never a complete audit)", () => {
    const result = handleToolResponse({
      stop_reason: "max_tokens",
      content: [{ type: "tool_use", input: { findings: [] } }],
    });
    expect(result.truncated).toBe(true);
    expect(result.payload).toEqual({ findings: [] });
  });

  it("truncated=false for normal end_turn tool responses", () => {
    const result = handleToolResponse({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", input: { findings: [1] } }],
    });
    expect(result.truncated).toBe(false);
  });

  it("throws visibly when no tool_use block exists (never silent zeros)", () => {
    expect(() =>
      handleToolResponse({ stop_reason: "end_turn", content: [{ type: "text" }] }),
    ).toThrow(/no tool call back/);
  });
});

describe("payload normalization defenses", () => {
  it("unwraps a single-key wrapper layer", () => {
    expect(unwrapNestedToolInput({ submit_audit: { findings: [], inspected: {} } })).toEqual({
      findings: [],
      inspected: {},
    });
  });

  it("leaves valid multi-key payloads untouched", () => {
    const payload = { findings: [], inspected: {} };
    expect(unwrapNestedToolInput(payload)).toBe(payload);
  });

  it("decodes stringified-array fields (observed live via OpenRouter)", () => {
    const result = normalizeToolInput({ findings: '[{"title":"t"}]' });
    expect(result).toEqual({ findings: [{ title: "t" }] });
  });

  it("leaves non-decodable strings as-is for downstream lenient handling", () => {
    expect(normalizeToolInput({ findings: "not json [" })).toEqual({ findings: "not json [" });
  });
});
