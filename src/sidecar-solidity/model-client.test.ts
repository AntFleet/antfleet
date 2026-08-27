import { describe, it, expect } from "vitest";
import { handleChatResponse, normalizeToolInput, unwrapNestedToolInput } from "./model-client.js";

describe("handleChatResponse — truncation safety (item 5) + JSON parse", () => {
  it("marks truncated=true when finish_reason is length (never a complete audit)", () => {
    const result = handleChatResponse({
      choices: [{ message: { content: '{"findings":[]}' }, finish_reason: "length" }],
    });
    expect(result.truncated).toBe(true);
    expect(result.payload).toEqual({ findings: [] });
  });

  it("truncated=false for a normal stop", () => {
    const result = handleChatResponse({
      choices: [{ message: { content: '{"findings":[1]}' }, finish_reason: "stop" }],
    });
    expect(result.truncated).toBe(false);
  });

  it("strips a ```json fence the model added despite instructions", () => {
    const result = handleChatResponse({
      choices: [{ message: { content: '```json\n{"findings":[]}\n```' }, finish_reason: "stop" }],
    });
    expect(result.payload).toEqual({ findings: [] });
  });

  it("throws visibly on empty content (never silent zeros)", () => {
    expect(() =>
      handleChatResponse({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }),
    ).toThrow(/empty content/);
  });

  it("throws visibly on non-JSON content", () => {
    expect(() =>
      handleChatResponse({
        choices: [{ message: { content: "sorry, no JSON here" }, finish_reason: "stop" }],
      }),
    ).toThrow(/not valid JSON/);
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
