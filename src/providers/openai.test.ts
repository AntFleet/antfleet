import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type OpenAI from "openai";
import { openaiProvider, extractOpenAIContent } from "./openai.js";
import { reviewOutputSchema } from "../types.js";
import { FleetError } from "../errors.js";

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
    expect(status).toMatch(/gpt-5/u);
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
      model: "gpt-5",
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
      model: "gpt-5",
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
