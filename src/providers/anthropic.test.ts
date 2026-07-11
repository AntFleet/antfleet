import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropicProvider, extractAnthropicToolOutput, tolerateReviewShape } from "./anthropic.js";
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
    expect(() => extractAnthropicToolOutput(fixture, "wrong_tool_name")).toThrow(
      /wrong_tool_name/u,
    );
  });

  it("ignores text content blocks and only returns tool_use input", async () => {
    const fixture = await loadFixture("anthropic-review-with-findings.json");
    const withText: Anthropic.Messages.Message = {
      ...fixture,
      content: [{ type: "text", text: "Here is the review:", citations: null }, ...fixture.content],
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

  it("unwraps the { review: {...} } wrapper variant Opus 4.7 also emits", async () => {
    // Slice 4d real-PR diagnostic captured this second wrapper key — the model
    // sometimes echoes the tool-name stem ("review" from "submit_review")
    // instead of "input".
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
          input: { review: expected },
        },
      ],
    };
    const raw = extractAnthropicToolOutput(wrapped, "submit_review");
    expect(raw).toEqual(expected);
    const parsed = reviewOutputSchema.parse(raw);
    expect(parsed.findings).toHaveLength(1);
  });

  it("does not unwrap when there are multiple top-level keys", async () => {
    // A valid response (matching reviewJsonSchema) has >=2 top-level keys
    // (findings + inspected). Anything multi-key must pass through.
    const fixture = await loadFixture("anthropic-review-with-findings.json");
    const decoy: Anthropic.Messages.Message = {
      ...fixture,
      content: [
        {
          ...(fixture.content[0] as Extract<
            (typeof fixture.content)[number],
            { type: "tool_use" }
          >),
          input: { findings: [{ ok: true }], inspected: { files: [] } },
        },
      ],
    };
    const raw = extractAnthropicToolOutput(decoy, "submit_review");
    expect(raw).toEqual({ findings: [{ ok: true }], inspected: { files: [] } });
  });

  it("does not unwrap when the single-key value isn't an object", async () => {
    const fixture = await loadFixture("anthropic-review-with-findings.json");
    const decoy: Anthropic.Messages.Message = {
      ...fixture,
      content: [
        {
          ...(fixture.content[0] as Extract<
            (typeof fixture.content)[number],
            { type: "tool_use" }
          >),
          input: { findings: "not-an-object" },
        },
      ],
    };
    const raw = extractAnthropicToolOutput(decoy, "submit_review");
    expect(raw).toEqual({ findings: "not-an-object" });
  });
});

describe("tolerateReviewShape", () => {
  it("coerces a string `inspected` to an empty audit shell so findings parse", async () => {
    const fixture = await loadFixture("anthropic-review-with-findings.json");
    const properInput = (
      fixture.content[0] as Extract<(typeof fixture.content)[number], { type: "tool_use" }>
    ).input as { findings: unknown[]; inspected: unknown };
    const malformed = { findings: properInput.findings, inspected: "freeform summary text" };
    expect(() => reviewOutputSchema.parse(malformed)).toThrow();
    const tolerant = tolerateReviewShape(malformed);
    const parsed = reviewOutputSchema.parse(tolerant);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.inspected.files).toEqual([]);
    expect(parsed.inspected.symbols).toEqual([]);
    expect(parsed.inspected.notes).toEqual([]);
  });

  it("coerces missing `inspected` to an empty audit shell", () => {
    const tolerant = tolerateReviewShape({ findings: [] }) as { inspected: unknown };
    expect(tolerant.inspected).toEqual({ files: [], symbols: [], notes: [] });
  });

  it("coerces null `inspected` to an empty audit shell", () => {
    const tolerant = tolerateReviewShape({ findings: [], inspected: null }) as {
      inspected: unknown;
    };
    expect(tolerant.inspected).toEqual({ files: [], symbols: [], notes: [] });
  });

  it("leaves a well-formed `inspected` untouched", () => {
    const proper = {
      findings: [],
      inspected: { files: ["src/a.ts"], symbols: ["foo"], notes: ["note"] },
    };
    expect(tolerateReviewShape(proper)).toEqual(proper);
  });

  it("passes through non-object inputs (e.g. null, arrays)", () => {
    expect(tolerateReviewShape(null)).toBe(null);
    expect(tolerateReviewShape([])).toEqual([]);
    expect(tolerateReviewShape("string")).toBe("string");
  });
});

// Regression guard for #134 (AntSeed "0 findings on re-run"). Forensic replay
// of 11 PROD bench-antseed reviews showed every zero-finding run was an
// Anthropic schema-validation THROW — not model recall, not the matcher. Opus
// 4.7 intermittently (a) OMITS an `evidence[].quote` key entirely (Zod:
// `expected string, received undefined` at findings.N.evidence.M.quote) or
// (b) emits an off-enum `category` (`invalid_value`). Either threw the whole
// reviewOutputSchema.parse, and the 2-of-2 unanimous gate then discarded the
// ENTIRE review (every other valid finding + the other model's findings). The
// schema now tolerates exactly these two shapes; these tests pin that.
describe("reviewOutputSchema tolerance (#134 Opus 4.7 malformed findings)", () => {
  const validFinding = {
    title: "platformFee is zeroed when protocolReserve is unset",
    category: "bug",
    severity: "high",
    confidence: "high",
    evidence: [
      {
        path: "AntseedDeposits.sol",
        startLine: 42,
        endLine: 44,
        symbol: "deposit",
        quote: "fee = 0",
      },
    ],
    reasoning: "The fee is silently zeroed.",
    reproduction: null,
    recommendation: "Revert when protocolReserve == address(0).",
    whyTestsDoNotAlreadyCoverThis: "No test exercises the unset-reserve path.",
    suggestedRegressionTest: null,
    minimumFixScope: "One guard clause.",
  };
  const emptyInspected = { files: [], symbols: [], notes: [] };
  const wrap = (findings: unknown[]) => ({ findings, inspected: emptyInspected });

  it("parses a finding whose evidence entry OMITS the `quote` key (the exact #134 failure), coercing it to null", () => {
    // No `quote` key at all — pre-fix this threw at findings.0.evidence.0.quote.
    const evidence = [
      { path: "AntseedDeposits.sol", startLine: 42, endLine: 44, symbol: "deposit" },
    ];
    const parsed = reviewOutputSchema.parse(wrap([{ ...validFinding, evidence }]));
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]!.evidence[0]!.quote).toBeNull();
    expect(parsed.findings[0]!.evidence[0]!.symbol).toBe("deposit");
  });

  it("parses a finding whose evidence entry has ONLY `path`, defaulting every other field to null", () => {
    const parsed = reviewOutputSchema.parse(
      wrap([{ ...validFinding, evidence: [{ path: "a.sol" }] }]),
    );
    const ev = parsed.findings[0]!.evidence[0]!;
    expect([ev.startLine, ev.endLine, ev.symbol, ev.quote]).toEqual([null, null, null, null]);
  });

  it("falls back to `bug` for an off-enum category (the #134 invalid_value failure)", () => {
    const parsed = reviewOutputSchema.parse(wrap([{ ...validFinding, category: "correctness" }]));
    expect(parsed.findings[0]!.category).toBe("bug");
  });

  it("tolerates omitted nullable metadata keys on the finding (reproduction, suggestedRegressionTest)", () => {
    const { reproduction: _r, suggestedRegressionTest: _s, ...lean } = validFinding;
    const parsed = reviewOutputSchema.parse(wrap([lean]));
    expect(parsed.findings[0]!.reproduction).toBeNull();
    expect(parsed.findings[0]!.suggestedRegressionTest).toBeNull();
  });

  it("does not let one malformed finding discard the rest of the batch (the core #134 harm)", () => {
    // finding[1] carries BOTH malformations; the batch must still parse whole.
    const bad = { ...validFinding, category: "logic", evidence: [{ path: "x.sol", symbol: "y" }] };
    const parsed = reviewOutputSchema.parse(wrap([validFinding, bad, validFinding]));
    expect(parsed.findings).toHaveLength(3);
    expect(parsed.findings[1]!.category).toBe("bug");
    expect(parsed.findings[1]!.evidence[0]!.quote).toBeNull();
  });

  it("stays strict on required CONTENT — a missing title or evidence.path still throws (no over-tolerance)", () => {
    const { title: _t, ...noTitle } = validFinding;
    expect(() => reviewOutputSchema.parse(wrap([noTitle]))).toThrow();
    const noPath = { ...validFinding, evidence: [{ quote: "orphan" }] };
    expect(() => reviewOutputSchema.parse(wrap([noPath]))).toThrow();
  });
});
