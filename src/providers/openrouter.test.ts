import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type OpenAI from "openai";
import { openrouterProvider, extractOpenRouterContent } from "./openrouter.js";
import { reviewOutputSchema } from "../types.js";
import { FleetError } from "../errors.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

async function loadFixture(name: string): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const raw = await readFile(join(fixturesDir, name), "utf8");
  return JSON.parse(raw) as OpenAI.Chat.Completions.ChatCompletion;
}

// deferred to v2 — see ARCHITECTURE.md §Provider roster
describe.skip("openrouterProvider.check", () => {
  let originalKey: string | undefined;
  let originalFallback: string | undefined;

  beforeEach(() => {
    originalKey = process.env["OPENROUTER_API_KEY"];
    originalFallback = process.env["OPENROUTER_FALLBACK_MODEL"];
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env["OPENROUTER_API_KEY"];
    } else {
      process.env["OPENROUTER_API_KEY"] = originalKey;
    }
    if (originalFallback === undefined) {
      delete process.env["OPENROUTER_FALLBACK_MODEL"];
    } else {
      process.env["OPENROUTER_FALLBACK_MODEL"] = originalFallback;
    }
  });

  it("throws FleetError with remediation when OPENROUTER_API_KEY is missing", async () => {
    delete process.env["OPENROUTER_API_KEY"];
    await expect(openrouterProvider.check("/tmp/fake")).rejects.toThrow(FleetError);
    delete process.env["OPENROUTER_API_KEY"];
    await expect(openrouterProvider.check("/tmp/fake")).rejects.toThrow(/OPENROUTER_API_KEY/u);
  });

  it("returns a ready string mentioning both primary and fallback models", async () => {
    process.env["OPENROUTER_API_KEY"] = "sk-or-test-dummy-value-not-real";
    const status = await openrouterProvider.check("/tmp/fake");
    expect(status).toMatch(/openrouter ready/u);
    expect(status).toMatch(/deepseek\/deepseek-chat/u);
    expect(status).toMatch(/qwen/u);
  });

  it("honors OPENROUTER_FALLBACK_MODEL override in check() string", async () => {
    process.env["OPENROUTER_API_KEY"] = "sk-or-test-dummy-value-not-real";
    process.env["OPENROUTER_FALLBACK_MODEL"] = "meta-llama/llama-3.3-70b-instruct";
    const status = await openrouterProvider.check("/tmp/fake");
    expect(status).toMatch(/llama-3\.3-70b/u);
  });
});

// deferred to v2 — see ARCHITECTURE.md §Provider roster
describe.skip("extractOpenRouterContent", () => {
  it("parses a recorded DeepSeek-V3 response with findings", async () => {
    const response = await loadFixture("openrouter-review-with-findings.json");
    const raw = extractOpenRouterContent(response);
    const parsed = reviewOutputSchema.parse(raw);
    expect(parsed.findings).toHaveLength(1);
    const [first] = parsed.findings;
    expect(first?.category).toBe("concurrency");
    expect(first?.severity).toBe("high");
    expect(first?.evidence[0]?.path).toBe("src/counter.ts");
  });

  it("strips ```json fences before parsing (Qwen-style output)", async () => {
    const response = await loadFixture("openrouter-review-fenced.json");
    const raw = extractOpenRouterContent(response);
    const parsed = reviewOutputSchema.parse(raw);
    expect(parsed.findings).toEqual([]);
    expect(parsed.inspected.files).toEqual(["src/clean.ts"]);
  });

  it("throws FleetError when the response carries no choices", () => {
    const empty = {
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "deepseek/deepseek-chat",
      choices: [],
    } as unknown as OpenAI.Chat.Completions.ChatCompletion;
    expect(() => extractOpenRouterContent(empty)).toThrow(/no choices/u);
  });

  it("throws FleetError when the chosen message has empty content", () => {
    const blank = {
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "deepseek/deepseek-chat",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          logprobs: null,
          message: { role: "assistant", refusal: null, content: "" },
        },
      ],
    } as unknown as OpenAI.Chat.Completions.ChatCompletion;
    expect(() => extractOpenRouterContent(blank)).toThrow(/empty/u);
  });

  it("throws FleetError when content (after fence-strip) is invalid JSON", () => {
    const bad = {
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "deepseek/deepseek-chat",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          logprobs: null,
          message: {
            role: "assistant",
            refusal: null,
            content: "```json\nnot valid {{ json ::\n```",
          },
        },
      ],
    } as unknown as OpenAI.Chat.Completions.ChatCompletion;
    expect(() => extractOpenRouterContent(bad)).toThrow(/invalid JSON/u);
  });
});
