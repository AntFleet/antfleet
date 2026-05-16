import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropicProvider, extractAnthropicToolOutput } from "./anthropic.js";
import { reviewOutputSchema } from "../types.js";
import { FleetError } from "../errors.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

async function loadFixture(name: string): Promise<Anthropic.Messages.Message> {
  const raw = await readFile(join(fixturesDir, name), "utf8");
  return JSON.parse(raw) as Anthropic.Messages.Message;
}

describe("anthropicProvider.check", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env["ANTHROPIC_API_KEY"];
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env["ANTHROPIC_API_KEY"];
    } else {
      process.env["ANTHROPIC_API_KEY"] = originalKey;
    }
  });

  it("throws FleetError with remediation when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    await expect(anthropicProvider.check("/tmp/fake")).rejects.toThrow(FleetError);
    delete process.env["ANTHROPIC_API_KEY"];
    await expect(anthropicProvider.check("/tmp/fake")).rejects.toThrow(/ANTHROPIC_API_KEY/u);
  });

  it("returns a ready string when ANTHROPIC_API_KEY is set", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test-dummy-value-not-real";
    const status = await anthropicProvider.check("/tmp/fake");
    expect(status).toMatch(/anthropic ready/u);
    expect(status).toMatch(/claude-opus-4-7/u);
  });
});

describe("extractAnthropicToolOutput", () => {
  it("extracts the tool input from a recorded findings response", async () => {
    const response = await loadFixture("anthropic-review-with-findings.json");
    const raw = extractAnthropicToolOutput(response, "submit_review");
    const parsed = reviewOutputSchema.parse(raw);
    expect(parsed.findings).toHaveLength(1);
    const [first] = parsed.findings;
    expect(first?.category).toBe("bug");
    expect(first?.severity).toBe("high");
    expect(first?.evidence[0]?.path).toBe("src/handler.ts");
  });

  it("extracts an empty-findings response cleanly", async () => {
    const response = await loadFixture("anthropic-review-clean.json");
    const raw = extractAnthropicToolOutput(response, "submit_review");
    const parsed = reviewOutputSchema.parse(raw);
    expect(parsed.findings).toEqual([]);
    expect(parsed.inspected.files).toEqual(["src/clean.ts"]);
  });

  it("throws FleetError when the response carries no tool_use block matching the tool name", async () => {
    const fixture = await loadFixture("anthropic-review-with-findings.json");
    expect(() => extractAnthropicToolOutput(fixture, "wrong_tool_name")).toThrow(FleetError);
    expect(() => extractAnthropicToolOutput(fixture, "wrong_tool_name")).toThrow(/wrong_tool_name/u);
  });

  it("ignores text content blocks and only returns tool_use input", async () => {
    const fixture = await loadFixture("anthropic-review-with-findings.json");
    const withText: Anthropic.Messages.Message = {
      ...fixture,
      content: [
        { type: "text", text: "Here is the review:", citations: null },
        ...fixture.content,
      ],
    };
    const raw = extractAnthropicToolOutput(withText, "submit_review");
    expect(raw).toEqual(
      (fixture.content[0] as Extract<(typeof fixture.content)[number], { type: "tool_use" }>).input,
    );
  });

  it("unwraps the intermittent { input: {...} } wrapper Opus 4.7 emits", async () => {
    const fixture = await loadFixture("anthropic-review-with-findings.json");
    const expected = (
      fixture.content[0] as Extract<(typeof fixture.content)[number], { type: "tool_use" }>
    ).input;
    const wrapped: Anthropic.Messages.Message = {
      ...fixture,
      content: [
        {
          ...(fixture.content[0] as Extract<
            (typeof fixture.content)[number],
            { type: "tool_use" }
          >),
          input: { input: expected },
        },
      ],
    };
    const raw = extractAnthropicToolOutput(wrapped, "submit_review");
    expect(raw).toEqual(expected);
    const parsed = reviewOutputSchema.parse(raw);
    expect(parsed.findings).toHaveLength(1);
  });

  it("does not unwrap when the single key isn't 'input'", async () => {
    const fixture = await loadFixture("anthropic-review-with-findings.json");
    const decoy: Anthropic.Messages.Message = {
      ...fixture,
      content: [
        {
          ...(fixture.content[0] as Extract<
            (typeof fixture.content)[number],
            { type: "tool_use" }
          >),
          input: { findings: [{ ok: true }] },
        },
      ],
    };
    const raw = extractAnthropicToolOutput(decoy, "submit_review");
    expect(raw).toEqual({ findings: [{ ok: true }] });
  });
});
