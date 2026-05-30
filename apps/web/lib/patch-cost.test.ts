import { describe, it, expect } from "vitest";
import { ANTHROPIC_DEFAULT_MODEL } from "@antfleet/cli/providers/anthropic";
import { OPENAI_DEFAULT_MODEL } from "@antfleet/cli/providers/openai";
import {
  callCostUsd,
  estimatePatchCostUsd,
  patchTokensByFinding,
  toPersistableCostUsd,
  PATCH_TOKEN_PRICING_USD_PER_MTOK,
} from "./patch-cost";
import type { ProviderPatchProposal } from "./patch-generation";

// Build a minimal proposal; only the fields the cost layer reads matter.
const proposal = (over: Partial<ProviderPatchProposal>): ProviderPatchProposal => ({
  providerName: "anthropic",
  findingId: "fid-1",
  patch: null,
  modelId: "claude-opus-4-7",
  skipReason: null,
  rationale: null,
  usage: null,
  ...over,
});

describe("callCostUsd", () => {
  it("prices Opus at $15/MTok in + $75/MTok out", () => {
    // 1000 in + 1000 out → 0.015 + 0.075 = 0.09
    expect(
      callCostUsd("anthropic", "claude-opus-4-7", { inputTokens: 1000, outputTokens: 1000 }),
    ).toBeCloseTo(0.09, 10);
  });

  it("prices GPT-5 at $5/MTok in + $30/MTok out", () => {
    // 1000 in + 1000 out → 0.005 + 0.03 = 0.035
    expect(callCostUsd("openai", "gpt-5", { inputTokens: 1000, outputTokens: 1000 })).toBeCloseTo(
      0.035,
      10,
    );
  });

  it("returns 0 when usage is null (no billable call)", () => {
    expect(callCostUsd("anthropic", "claude-opus-4-7", null)).toBe(0);
  });

  it("falls back to the provider rate when the model id is unknown", () => {
    // Unknown model id but known provider → uses anthropic fallback (Opus rate).
    expect(
      callCostUsd("anthropic", "claude-opus-9-future", { inputTokens: 1000, outputTokens: 1000 }),
    ).toBeCloseTo(0.09, 10);
  });

  it("returns 0 when neither model id nor provider resolves to a rate", () => {
    expect(
      callCostUsd("mystery-provider", "mystery-model", { inputTokens: 1000, outputTokens: 1000 }),
    ).toBe(0);
  });

  it("documents both priced models in the pricing table", () => {
    expect(PATCH_TOKEN_PRICING_USD_PER_MTOK["claude-opus-4-7"]).toEqual({ input: 15, output: 75 });
    expect(PATCH_TOKEN_PRICING_USD_PER_MTOK["gpt-5"]).toEqual({ input: 5, output: 30 });
  });
});

describe("estimatePatchCostUsd", () => {
  it("sums the cost of every proposal call", () => {
    const proposals = [
      proposal({
        providerName: "anthropic",
        modelId: "claude-opus-4-7",
        usage: { inputTokens: 1000, outputTokens: 1000 },
      }),
      proposal({
        providerName: "openai",
        modelId: "gpt-5",
        usage: { inputTokens: 1000, outputTokens: 1000 },
      }),
    ];
    // 0.09 + 0.035 = 0.125
    expect(estimatePatchCostUsd(proposals)).toBe(0.125);
  });

  it("treats null-usage proposals as $0 and never goes non-zero on a precheck-only review", () => {
    const proposals = [
      proposal({ providerName: "anthropic", usage: null }),
      proposal({ providerName: "openai", modelId: "gpt-5", usage: null }),
    ];
    expect(estimatePatchCostUsd(proposals)).toBe(0);
  });

  it("rounds to 4 decimal places (numeric(10,4) column)", () => {
    const proposals = [
      proposal({
        providerName: "openai",
        modelId: "gpt-5",
        usage: { inputTokens: 333, outputTokens: 0 },
      }),
    ];
    // 333/1e6 * 5 = 0.001665 → rounds to 0.0017
    expect(estimatePatchCostUsd(proposals)).toBe(0.0017);
  });
});

describe("patchTokensByFinding", () => {
  it("splits usage per finding by provider (opus = anthropic, gpt5 = openai)", () => {
    const proposals = [
      proposal({
        findingId: "fid-1",
        providerName: "anthropic",
        usage: { inputTokens: 10, outputTokens: 2 },
      }),
      proposal({
        findingId: "fid-1",
        providerName: "openai",
        usage: { inputTokens: 20, outputTokens: 4 },
      }),
      proposal({
        findingId: "fid-2",
        providerName: "anthropic",
        usage: { inputTokens: 30, outputTokens: 6 },
      }),
    ];
    const map = patchTokensByFinding(proposals);
    expect(map.get("fid-1")).toEqual({
      opus: { inputTokens: 10, outputTokens: 2 },
      gpt5: { inputTokens: 20, outputTokens: 4 },
    });
    // fid-2 only had an anthropic proposal → gpt5 stays null.
    expect(map.get("fid-2")).toEqual({
      opus: { inputTokens: 30, outputTokens: 6 },
      gpt5: null,
    });
  });

  it("leaves a side null when that provider made no billable call", () => {
    const map = patchTokensByFinding([
      proposal({ findingId: "fid-1", providerName: "anthropic", usage: null }),
    ]);
    expect(map.get("fid-1")).toEqual({ opus: null, gpt5: null });
  });
});

describe("toPersistableCostUsd (numeric(10,4) guard)", () => {
  it("rounds a normal value to 4 dp", () => {
    expect(toPersistableCostUsd(0.123456)).toBe(0.1235);
  });

  it("coerces NaN / Infinity / negative to 0 (would otherwise throw on the DB write)", () => {
    expect(toPersistableCostUsd(NaN)).toBe(0);
    expect(toPersistableCostUsd(Infinity)).toBe(0);
    expect(toPersistableCostUsd(-1.5)).toBe(0);
  });

  it("clamps an over-range value to the column maximum", () => {
    expect(toPersistableCostUsd(10_000_000)).toBe(999_999.9999);
  });

  it("flows through estimatePatchCostUsd so a malformed usage block can't throw the write", () => {
    const bad = proposal({
      providerName: "anthropic",
      modelId: "claude-opus-4-7",
      usage: { inputTokens: Number.NaN, outputTokens: 0 },
    });
    expect(estimatePatchCostUsd([bad])).toBe(0);
  });
});

describe("pricing-table staleness forcing function", () => {
  // These fail CI the moment the default model bumps without a matching
  // pricing entry — converting silent mispricing-via-fallback into a loud
  // signal that the VERIFY-BY rates need confirming for the new model.
  it("prices the current default Anthropic model explicitly (no silent fallback)", () => {
    expect(PATCH_TOKEN_PRICING_USD_PER_MTOK[ANTHROPIC_DEFAULT_MODEL]).toBeDefined();
  });

  it("prices the current default OpenAI model explicitly (no silent fallback)", () => {
    expect(PATCH_TOKEN_PRICING_USD_PER_MTOK[OPENAI_DEFAULT_MODEL]).toBeDefined();
  });
});
