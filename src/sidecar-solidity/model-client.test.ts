import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  handleChatResponse,
  handleCodexOutput,
  normalizeToolInput,
  toCodexModelId,
  useHttpTransport,
  unwrapNestedToolInput,
} from "./model-client.js";

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

describe("handleCodexOutput — codex CLI transport (DEFAULT) output handling", () => {
  it("parses the plain JSON codex writes to its -o file", () => {
    const result = handleCodexOutput('{"findings":[],"inspected":{"files":[],"notes":[]}}');
    expect(result.payload).toEqual({ findings: [], inspected: { files: [], notes: [] } });
    // codex exposes no finish_reason: a cut-off surfaces as a parse error instead.
    expect(result.truncated).toBe(false);
  });

  it("strips a ```json fence codex added despite instructions", () => {
    const result = handleCodexOutput('```json\n{"findings":[],"inspected":{}}\n```');
    expect(result.payload).toEqual({ findings: [], inspected: {} });
  });

  it("unwraps a single-key wrapper layer", () => {
    expect(handleCodexOutput('{"submit_audit":{"findings":[],"inspected":{}}}').payload).toEqual({
      findings: [],
      inspected: {},
    });
  });

  it("normalizes a stringified-array field", () => {
    expect(
      handleCodexOutput('{"findings":"[{\\"title\\":\\"t\\"}]","inspected":{}}').payload,
    ).toEqual({ findings: [{ title: "t" }], inspected: {} });
  });

  it("throws visibly on empty output (never silent zeros)", () => {
    expect(() => handleCodexOutput("")).toThrow(/empty content/);
    expect(() => handleCodexOutput("   \n ")).toThrow(/empty content/);
  });

  it("throws visibly on non-JSON output (a truncated codex run lands here)", () => {
    expect(() => handleCodexOutput("I could not complete the audit.")).toThrow(/not valid JSON/);
    expect(() => handleCodexOutput('{"findings":[')).toThrow(/not valid JSON/);
  });
});

describe("toCodexModelId — same per-role models, codex id spelling", () => {
  it("strips the OpenRouter vendor prefix for the codex -m arg", () => {
    expect(toCodexModelId("openai/gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(toCodexModelId("openai/gpt-5.5")).toBe("gpt-5.5");
  });

  it("leaves an already-bare id untouched", () => {
    expect(toCodexModelId("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });
});

function clearTransportEnv(): void {
  delete process.env["SIDECAR_TRANSPORT"];
  delete process.env["SIDECAR_BASE_URL"];
}

describe("useHttpTransport — codex is the DEFAULT, HTTP is opt-in", () => {
  const saved = {
    transport: process.env["SIDECAR_TRANSPORT"],
    baseUrl: process.env["SIDECAR_BASE_URL"],
  };

  beforeEach(clearTransportEnv);
  afterEach(() => {
    clearTransportEnv();
    if (saved.transport !== undefined) {
      process.env["SIDECAR_TRANSPORT"] = saved.transport;
    }
    if (saved.baseUrl !== undefined) {
      process.env["SIDECAR_BASE_URL"] = saved.baseUrl;
    }
  });

  it("defaults to codex when neither env var is set", () => {
    expect(useHttpTransport()).toBe(false);
  });

  it("switches to HTTP on SIDECAR_TRANSPORT=http", () => {
    process.env["SIDECAR_TRANSPORT"] = "http";
    expect(useHttpTransport()).toBe(true);
  });

  it("switches to HTTP when SIDECAR_BASE_URL is set (only the HTTP client has a base URL)", () => {
    process.env["SIDECAR_BASE_URL"] = "https://api.openai.com/v1";
    expect(useHttpTransport()).toBe(true);
  });

  it("stays on codex for any other SIDECAR_TRANSPORT value", () => {
    process.env["SIDECAR_TRANSPORT"] = "codex";
    expect(useHttpTransport()).toBe(false);
  });
});
