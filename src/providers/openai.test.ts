import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type OpenAI from "openai";
import { openaiProvider, extractOpenAIContent, OPENAI_MAX_TOKENS } from "./openai.js";
import { reviewOutputSchema } from "../types.js";
import { FleetError } from "../errors.js";

// Spy target captured at module scope so the vi.mock factory (which is
// hoisted and cannot close over later-declared let bindings) can reference
// it through a stable wrapper object.
const sdkSpy = { create: vi.fn() }; // eslint-disable-line -- module-scope mock target

vi.mock("openai", async (importOriginal) => {
  // Preserve the real OpenAI type for extractOpenAIContent / fixture tests.
  const actual = await importOriginal<typeof import("openai")>();
  const OriginalOpenAI = actual.default;
  class MockOpenAI extends OriginalOpenAI {
    override chat = {
      completions: { create: sdkSpy.create },
    } as unknown as OpenAI["chat"];
  }
  return { ...actual, default: MockOpenAI };
});

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

async function loadFixture(name: string): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const raw = await readFile(join(fixturesDir, name), "utf8");
  return JSON.parse(raw) as OpenAI.Chat.Completions.ChatCompletion;
}

describe("openaiProvider.check", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env["OPENAI_API_KEY"];
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env["OPENAI_API_KEY"];
    } else {
      process.env["OPENAI_API_KEY"] = originalKey;
    }
  });

  it("throws FleetError with remediation when OPENAI_API_KEY is missing", async () => {
    delete process.env["OPENAI_API_KEY"];
    await expect(openaiProvider.check("/tmp/fake")).rejects.toThrow(FleetError);
    delete process.env["OPENAI_API_KEY"];
    await expect(openaiProvider.check("/tmp/fake")).rejects.toThrow(/OPENAI_API_KEY/u);
  });

  it("returns a ready string when OPENAI_API_KEY is set", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test-dummy-value-not-real";
    const status = await openaiProvider.check("/tmp/fake");
    expect(status).toMatch(/openai ready/u);
    expect(status).toMatch(/gpt-5\.5/u);
  });
});

describe("extractOpenAIContent", () => {
  it("parses a recorded chat completion with structured JSON content", async () => {
    const response = await loadFixture("openai-review-with-findings.json");
    const raw = extractOpenAIContent(response);
    const parsed = reviewOutputSchema.parse(raw);
    expect(parsed.findings).toHaveLength(1);
    const [first] = parsed.findings;
    expect(first?.category).toBe("security");
    expect(first?.severity).toBe("critical");
    expect(first?.evidence[0]?.path).toBe("src/db.ts");
  });

  it("throws FleetError when the response carries no choices", () => {
    const empty = {
      id: "chatcmpl_empty",
      object: "chat.completion",
      created: 0,
      model: "gpt-5.5",
      choices: [],
    } as unknown as OpenAI.Chat.Completions.ChatCompletion;
    expect(() => extractOpenAIContent(empty)).toThrow(FleetError);
    expect(() => extractOpenAIContent(empty)).toThrow(/no choices/u);
  });

  it("throws FleetError when the chosen message has empty content", () => {
    const blank = {
      id: "chatcmpl_blank",
      object: "chat.completion",
      created: 0,
      model: "gpt-5.5",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          logprobs: null,
          message: { role: "assistant", refusal: null, content: "" },
        },
      ],
    } as unknown as OpenAI.Chat.Completions.ChatCompletion;
    expect(() => extractOpenAIContent(blank)).toThrow(FleetError);
    expect(() => extractOpenAIContent(blank)).toThrow(/empty/u);
  });

  it("throws FleetError when content is not valid JSON", async () => {
    const response = await loadFixture("openai-review-malformed.json");
    expect(() => extractOpenAIContent(response)).toThrow(FleetError);
    expect(() => extractOpenAIContent(response)).toThrow(/invalid JSON/u);
  });
});

describe("OPENAI_MAX_TOKENS cap", () => {
  it("constant is 32768 — asymmetric to Anthropic's 16384 because GPT-5 reasoning tokens count against this budget", () => {
    expect(OPENAI_MAX_TOKENS).toBe(32768);
  });

  describe("sends max_completion_tokens on every chat completion request", () => {
    let originalKey: string | undefined;

    beforeEach(() => {
      originalKey = process.env["OPENAI_API_KEY"];
      process.env["OPENAI_API_KEY"] = "sk-test-dummy-cap-value";
      sdkSpy.create.mockReset();
    });

    afterEach(() => {
      if (originalKey === undefined) {
        delete process.env["OPENAI_API_KEY"];
      } else {
        process.env["OPENAI_API_KEY"] = originalKey;
      }
    });

    it("review() passes max_completion_tokens=32768 to chat.completions.create", async () => {
      const fixture = await loadFixture("openai-review-with-findings.json");
      sdkSpy.create.mockResolvedValue(fixture);

      await openaiProvider.review("/tmp/fake", "test prompt", null);

      expect(sdkSpy.create).toHaveBeenCalledOnce();
      const [body] = sdkSpy.create.mock.calls[0] as [Record<string, unknown>, ...unknown[]];
      expect(body["max_completion_tokens"]).toBe(OPENAI_MAX_TOKENS);
      // Legacy `max_tokens` must not be set — GPT-5 rejects it with a 400.
      expect(body["max_tokens"]).toBeUndefined();
    });
  });
});
