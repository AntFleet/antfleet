import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config as loadEnv } from "dotenv";
import type Anthropic from "@anthropic-ai/sdk";
import {
  zhipuProvider,
  extractZhipuText,
  makeZhipuClient,
  resolveZhipuModel,
  callZhipu,
  ZHIPU_DEFAULT_MODEL,
} from "./zhipu.js";
import { extractAnthropicToolOutput } from "./anthropic.js";
import { reviewOutputSchema } from "../types.js";
import { FleetError } from "../errors.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

async function loadFixture(name: string): Promise<Anthropic.Messages.Message> {
  const raw = await readFile(join(fixturesDir, name), "utf8");
  return JSON.parse(raw) as Anthropic.Messages.Message;
}

// Live-test creds: pull ZHIPU_API_KEY from apps/web/.env.local (gitignored) so
// the smoke test can run locally without polluting the process env. CI has no
// key → the smoke describe below is skipped.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
loadEnv({ path: join(repoRoot, "apps", "web", ".env.local") });
const LIVE_KEY = process.env["ZHIPU_API_KEY"];
const hasLiveKey = LIVE_KEY !== undefined && LIVE_KEY.length > 0;

describe("zhipuProvider.check", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env["ZHIPU_API_KEY"];
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env["ZHIPU_API_KEY"];
    } else {
      process.env["ZHIPU_API_KEY"] = originalKey;
    }
  });

  it("throws FleetError with remediation when ZHIPU_API_KEY is missing", async () => {
    delete process.env["ZHIPU_API_KEY"];
    await expect(zhipuProvider.check("/tmp/fake")).rejects.toThrow(FleetError);
    delete process.env["ZHIPU_API_KEY"];
    await expect(zhipuProvider.check("/tmp/fake")).rejects.toThrow(/ZHIPU_API_KEY/u);
  });

  it("returns a ready string mentioning the default model when the key is set", async () => {
    process.env["ZHIPU_API_KEY"] = "test-dummy-value-not-real";
    const status = await zhipuProvider.check("/tmp/fake");
    expect(status).toMatch(/zhipu ready/u);
    expect(status).toMatch(/glm-5\.2/u);
  });
});

describe("zhipu review extraction (recorded fixture)", () => {
  it("extracts the tool input and parses it through reviewOutputSchema", async () => {
    const response = await loadFixture("zhipu-review-with-findings.json");
    const raw = extractAnthropicToolOutput(response, "submit_review");
    const parsed = reviewOutputSchema.parse(raw);
    expect(parsed.findings).toHaveLength(1);
    const [first] = parsed.findings;
    expect(first?.category).toBe("bug");
    expect(first?.severity).toBe("high");
    expect(first?.evidence[0]?.path).toBe("src/parser.ts");
    // Defaulted fields survive the parse (proves schema-valid Finding[]).
    expect(first?.requiresPolicyReview).toBe(false);
    expect(first?.upstreamOrigin).toBe(null);
  });
});

describe("extractZhipuText (judgment path)", () => {
  it("returns the concatenated text content of a GLM message", async () => {
    const response = await loadFixture("zhipu-judgment-text.json");
    const text = extractZhipuText(response);
    const judgment = JSON.parse(text) as { verdict: string };
    expect(judgment.verdict).toBe("confirm");
  });

  it("throws FleetError on empty text content (reasoning-token starvation)", () => {
    const blank = {
      id: "x",
      type: "message",
      role: "assistant",
      model: "glm-5.2",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "   ", citations: null }],
    } as unknown as Anthropic.Messages.Message;
    expect(() => extractZhipuText(blank)).toThrow(FleetError);
    expect(() => extractZhipuText(blank)).toThrow(/empty text/u);
  });

  it("throws FleetError when the message carries no text blocks", () => {
    const noText = {
      id: "x",
      type: "message",
      role: "assistant",
      model: "glm-5.2",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t", name: "foo", input: {} }],
    } as unknown as Anthropic.Messages.Message;
    expect(() => extractZhipuText(noText)).toThrow(/empty text/u);
  });
});

describe("resolveZhipuModel", () => {
  let originalModel: string | undefined;

  beforeEach(() => {
    originalModel = process.env["ZHIPU_MODEL"];
  });

  afterEach(() => {
    if (originalModel === undefined) {
      delete process.env["ZHIPU_MODEL"];
    } else {
      process.env["ZHIPU_MODEL"] = originalModel;
    }
  });

  it("defaults to glm-5.2", () => {
    delete process.env["ZHIPU_MODEL"];
    expect(resolveZhipuModel()).toBe(ZHIPU_DEFAULT_MODEL);
    expect(ZHIPU_DEFAULT_MODEL).toBe("glm-5.2");
  });

  it("honors an explicit model argument over the env override", () => {
    process.env["ZHIPU_MODEL"] = "glm-env";
    expect(resolveZhipuModel("glm-explicit")).toBe("glm-explicit");
  });

  it("falls back to ZHIPU_MODEL when no argument is given", () => {
    process.env["ZHIPU_MODEL"] = "glm-env";
    expect(resolveZhipuModel()).toBe("glm-env");
  });
});

describe("makeZhipuClient", () => {
  let originalKey: string | undefined;
  let originalBase: string | undefined;

  beforeEach(() => {
    originalKey = process.env["ZHIPU_API_KEY"];
    originalBase = process.env["ZHIPU_BASE_URL"];
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env["ZHIPU_API_KEY"];
    else process.env["ZHIPU_API_KEY"] = originalKey;
    if (originalBase === undefined) delete process.env["ZHIPU_BASE_URL"];
    else process.env["ZHIPU_BASE_URL"] = originalBase;
  });

  it("throws when the key is missing", () => {
    delete process.env["ZHIPU_API_KEY"];
    expect(() => makeZhipuClient()).toThrow(/ZHIPU_API_KEY/u);
  });

  it("points the Anthropic client at the z.ai base URL by default", () => {
    process.env["ZHIPU_API_KEY"] = "test-dummy-value-not-real";
    delete process.env["ZHIPU_BASE_URL"];
    const client = makeZhipuClient();
    expect(client.baseURL).toBe("https://api.z.ai/api/anthropic");
  });

  it("honors a ZHIPU_BASE_URL override", () => {
    process.env["ZHIPU_API_KEY"] = "test-dummy-value-not-real";
    process.env["ZHIPU_BASE_URL"] = "https://example.test/anthropic";
    const client = makeZhipuClient();
    expect(client.baseURL).toBe("https://example.test/anthropic");
  });
});

// LIVE smoke — key-gated so CI without ZHIPU_API_KEY skips it. Small real spend.
const PLANTED_BUG_DIFF = [
  "diff --git a/src/index.ts b/src/index.ts",
  "--- a/src/index.ts",
  "+++ b/src/index.ts",
  "@@ -1,3 +1,7 @@",
  "+export function firstElement(items: number[]): number {",
  "+  // BUG: no empty-array guard; items[0] is undefined and coerces downstream.",
  "+  return items[0] + 1;",
  "+}",
  "+",
].join("\n");

describe.skipIf(!hasLiveKey)("zhipu LIVE smoke (needs ZHIPU_API_KEY)", () => {
  it("check() succeeds against the configured key", async () => {
    const status = await zhipuProvider.check("/tmp/fake");
    expect(status).toMatch(/zhipu ready/u);
  });

  it("review() on a planted-bug diff returns a schema-valid Finding[] with >=1 finding", async () => {
    const prompt = [
      "You are a code reviewer. Review the following unified diff for correctness bugs.",
      "Call the submit_review tool with your structured findings.",
      "",
      PLANTED_BUG_DIFF,
    ].join("\n");
    const result = await zhipuProvider.review("/tmp/fake", prompt, null);
    // reviewOutputSchema already parsed inside review(); re-assert for clarity.
    const parsed = reviewOutputSchema.parse(result);
    // eslint-disable-next-line no-console
    console.log(`[zhipu live smoke] findings=${parsed.findings.length}`);
    expect(parsed.findings.length).toBeGreaterThanOrEqual(1);
  }, 240_000);

  it("callZhipu() makes an arbitrary judgment call and returns text + usage", async () => {
    const { text, usage } = await callZhipu(
      "You are a terse judge. Answer with a single word.",
      "Is water wet? Answer yes or no.",
    );
    // eslint-disable-next-line no-console
    console.log(
      `[zhipu live smoke] judgment usage in=${usage?.inputTokens ?? "?"} out=${usage?.outputTokens ?? "?"}`,
    );
    expect(text.length).toBeGreaterThan(0);
  }, 240_000);
});
