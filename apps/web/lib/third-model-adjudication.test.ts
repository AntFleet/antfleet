import { describe, it, expect, vi } from "vitest";
import {
  runAdjudication,
  applyThirdModelAdjudication,
  ADJUDICATION_MODEL,
  type AdjudicationOutcome,
} from "./third-model-adjudication";
import type { Finding } from "./review-types";

function mkFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    title: "Unchecked external call return value",
    category: "security",
    severity: "high",
    label: "blocking",
    confidence: "high",
    evidence: [
      {
        path: "src/Vault.sol",
        startLine: 88,
        endLine: 90,
        symbol: "withdraw",
        quote: "token.transfer(to, amount);",
      },
    ],
    reasoning: "the boolean return is ignored",
    reproduction: null,
    recommendation: "check the return value",
    whyTestsDoNotAlreadyCoverThis: "",
    suggestedRegressionTest: null,
    minimumFixScope: "",
    requiresPolicyReview: false,
    upstreamOrigin: null,
    ...overrides,
  };
}

// A callModel stub that returns fixed JSON text.
function jsonModel(obj: unknown): (s: string, u: string) => Promise<string> {
  return async () => JSON.stringify(obj);
}

describe("runAdjudication (confirm/reject)", () => {
  it("confirm → corroborated=true", async () => {
    const out = await runAdjudication({
      finding: mkFinding(),
      flaggingProvider: "anthropic",
      callModel: jsonModel({ verdict: "confirm", reason: "return ignored, real bug" }),
    });
    expect(out.verdict).toBe("confirm");
    expect(out.corroborated).toBe(true);
    expect(out.error).toBeNull();
    expect(out.thirdModel).toBe(ADJUDICATION_MODEL);
  });

  it("reject → corroborated=false", async () => {
    const out = await runAdjudication({
      finding: mkFinding(),
      flaggingProvider: "openai",
      callModel: jsonModel({ verdict: "reject", reason: "false positive" }),
    });
    expect(out.verdict).toBe("reject");
    expect(out.corroborated).toBe(false);
    expect(out.error).toBeNull();
  });

  it("uncertain → corroborated=false", async () => {
    const out = await runAdjudication({
      finding: mkFinding(),
      flaggingProvider: "anthropic",
      callModel: jsonModel({ verdict: "uncertain", reason: "cannot tell" }),
    });
    expect(out.verdict).toBe("uncertain");
    expect(out.corroborated).toBe(false);
  });

  it("fail-open → uncertain on API error", async () => {
    const out = await runAdjudication({
      finding: mkFinding(),
      flaggingProvider: "anthropic",
      callModel: async () => {
        throw new Error("z.ai 503");
      },
    });
    expect(out.verdict).toBe("uncertain");
    expect(out.corroborated).toBe(false);
    expect(out.error).toContain("z.ai 503");
  });

  it("fail-open → uncertain on unparseable JSON", async () => {
    const out = await runAdjudication({
      finding: mkFinding(),
      flaggingProvider: "anthropic",
      callModel: async () => "not json at all",
    });
    expect(out.verdict).toBe("uncertain");
    expect(out.corroborated).toBe(false);
    expect(out.error).not.toBeNull();
  });

  it("fail-open → uncertain on missing verdict field", async () => {
    const out = await runAdjudication({
      finding: mkFinding(),
      flaggingProvider: "openai",
      callModel: jsonModel({ reason: "no verdict key" }),
    });
    expect(out.verdict).toBe("uncertain");
    expect(out.corroborated).toBe(false);
    expect(out.error).toContain("verdict");
  });

  it("strips a ```json fence before parsing", async () => {
    const out = await runAdjudication({
      finding: mkFinding(),
      flaggingProvider: "anthropic",
      callModel: async () => '```json\n{"verdict":"confirm","reason":"ok"}\n```',
    });
    expect(out.verdict).toBe("confirm");
    expect(out.corroborated).toBe(true);
  });

  it("self-review guard — same-family adjudicator skips (corroborated=false) without calling model", async () => {
    const spy = vi.fn(jsonModel({ verdict: "confirm", reason: "should not run" }));
    // A hypothetical zhipu/glm-flagged finding — adjudicator family == flagging
    // family. Must skip and never invoke the model.
    const out = await runAdjudication({
      finding: mkFinding(),
      flaggingProvider: "zhipu",
      callModel: spy,
    });
    expect(out.corroborated).toBe(false);
    expect(out.verdict).toBe("uncertain");
    expect(out.error).toContain("self-review guard");
    expect(spy).not.toHaveBeenCalled();
  });

  it("passes independent framing — prompt never names the flagging provider", async () => {
    let capturedSystem = "";
    let capturedUser = "";
    await runAdjudication({
      finding: mkFinding({ title: "SQLi in query builder" }),
      flaggingProvider: "anthropic",
      callModel: async (s, u) => {
        capturedSystem = s;
        capturedUser = u;
        return JSON.stringify({ verdict: "confirm", reason: "ok" });
      },
    });
    const combined = `${capturedSystem}\n${capturedUser}`.toLowerCase();
    expect(combined).not.toContain("anthropic");
    expect(combined).not.toContain("do you agree");
    // Finding text is fenced as DATA.
    expect(capturedUser).toContain("untrusted-");
    expect(capturedUser).toContain("SQLi in query builder");
  });
});

describe("applyThirdModelAdjudication", () => {
  const mkOutcome = (
    verdict: AdjudicationOutcome["verdict"],
    corroborated: boolean,
  ): AdjudicationOutcome => ({
    verdict,
    corroborated,
    reason: "r",
    thirdModel: ADJUDICATION_MODEL,
    ms: 1,
    error: null,
  });

  it("returns per-finding rows in input order with corroboratedCount", async () => {
    const tier = [
      { finding: mkFinding({ title: "A" }), provider: "anthropic" },
      { finding: mkFinding({ title: "B" }), provider: "openai" },
      { finding: mkFinding({ title: "C" }), provider: "anthropic" },
    ];
    const runOne = vi
      .fn()
      .mockResolvedValueOnce(mkOutcome("confirm", true))
      .mockResolvedValueOnce(mkOutcome("reject", false))
      .mockResolvedValueOnce(mkOutcome("confirm", true));
    const res = await applyThirdModelAdjudication({ singleModelTier: tier, runOne });
    expect(res.rows.map((r) => r.corroborated)).toEqual([true, false, true]);
    expect(res.rows.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(res.corroboratedCount).toBe(2);
    expect(runOne).toHaveBeenCalledTimes(3);
  });

  it("empty tier → no calls, empty result", async () => {
    const runOne = vi.fn();
    const res = await applyThirdModelAdjudication({ singleModelTier: [], runOne });
    expect(res.rows).toEqual([]);
    expect(res.corroboratedCount).toBe(0);
    expect(runOne).not.toHaveBeenCalled();
  });

  it("60s cap — a hung adjudication batch fails open (all corroborated=false)", async () => {
    vi.useFakeTimers();
    try {
      const tier = [{ finding: mkFinding(), provider: "anthropic" }];
      // runOne never resolves until aborted — simulate a hang.
      const runOne = vi.fn().mockImplementation(
        ({ signal }: { signal?: AbortSignal | null }) =>
          new Promise<AdjudicationOutcome>((resolve) => {
            signal?.addEventListener("abort", () => resolve(mkOutcome("uncertain", false)));
          }),
      );
      const promise = applyThirdModelAdjudication({ singleModelTier: tier, runOne });
      await vi.advanceTimersByTimeAsync(61_000);
      const res = await promise;
      expect(res.corroboratedCount).toBe(0);
      expect(res.rows.every((r) => r.corroborated === false)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
