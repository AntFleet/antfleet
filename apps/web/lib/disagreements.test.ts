import { describe, expect, it } from "vitest";
import {
  classifyDisagreements,
  evidenceOverlaps,
  redactSecrets,
  type DisagreementRow,
} from "./disagreements";

const REVIEW_ID = "12345678-90ab-cdef-1234-567890abcdef";
const CREATED_AT = new Date("2026-05-24T00:00:00.000Z");

type FixtureFinding = {
  title?: string;
  category?: string;
  severity?: string;
  confidence?: string;
  evidence?: Array<{ path: string; startLine: number | null; endLine: number | null }>;
  reasoning?: string;
  recommendation?: string;
};

function finding(overrides: FixtureFinding = {}): Required<FixtureFinding> {
  return {
    title: "Null dereference",
    category: "bug",
    severity: "high",
    confidence: "high",
    evidence: [{ path: "src/app.ts", startLine: 10, endLine: 12 }],
    reasoning: "The value can be null.",
    recommendation: "Check for null before use.",
    ...overrides,
  };
}

function providerResponses(args: {
  anthropic?: FixtureFinding[];
  openai?: FixtureFinding[];
}): unknown {
  return {
    perProvider: [
      {
        name: "anthropic",
        ms: 100,
        ok: true,
        output: { findings: (args.anthropic ?? []).map((item) => finding(item)) },
      },
      {
        name: "openai",
        ms: 110,
        ok: true,
        output: { findings: (args.openai ?? []).map((item) => finding(item)) },
      },
    ],
  };
}

function classify(
  providerResponsesValue: unknown,
  agreementDecision: unknown = {},
): DisagreementRow[] {
  return classifyDisagreements(
    providerResponsesValue,
    agreementDecision,
    REVIEW_ID,
    "a".repeat(64),
    42,
    CREATED_AT,
  );
}

describe("evidenceOverlaps", () => {
  it("returns true for same file with overlapping lines", () => {
    expect(
      evidenceOverlaps(
        [{ path: "src/app.ts", startLine: 10, endLine: 20 }],
        [{ path: "src/app.ts", startLine: 15, endLine: 25 }],
      ),
    ).toBe(true);
  });

  it("returns true when same-file lines differ by exactly the tolerance", () => {
    expect(
      evidenceOverlaps(
        [{ path: "src/app.ts", startLine: 10, endLine: 10 }],
        [{ path: "src/app.ts", startLine: 15, endLine: 15 }],
        5,
      ),
    ).toBe(true);
  });

  it("returns false when same-file lines differ by tolerance plus one", () => {
    expect(
      evidenceOverlaps(
        [{ path: "src/app.ts", startLine: 10, endLine: 10 }],
        [{ path: "src/app.ts", startLine: 16, endLine: 16 }],
        5,
      ),
    ).toBe(false);
  });

  it("returns false for different files", () => {
    expect(
      evidenceOverlaps(
        [{ path: "src/app.ts", startLine: 10, endLine: 10 }],
        [{ path: "src/other.ts", startLine: 10, endLine: 10 }],
      ),
    ).toBe(false);
  });

  it("returns true when both start lines are null on the same path", () => {
    expect(
      evidenceOverlaps(
        [{ path: "src/app.ts", startLine: null, endLine: null }],
        [{ path: "src/app.ts", startLine: null, endLine: null }],
      ),
    ).toBe(true);
  });

  it("returns false when only one start line is null", () => {
    expect(
      evidenceOverlaps(
        [{ path: "src/app.ts", startLine: null, endLine: null }],
        [{ path: "src/app.ts", startLine: 10, endLine: 10 }],
      ),
    ).toBe(false);
  });
});

describe("classifyDisagreements solo findings", () => {
  it("returns one solo_anthropic row when only Anthropic has a finding", () => {
    const rows = classify(providerResponses({ anthropic: [{}], openai: [] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe("solo_anthropic");
    expect(rows[0]?.primaryFinding.provider).toBe("anthropic");
    expect(rows[0]?.counterpartFinding).toBeNull();
  });

  it("returns one solo_openai row when only OpenAI has a finding", () => {
    const rows = classify(providerResponses({ anthropic: [], openai: [{}] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe("solo_openai");
    expect(rows[0]?.primaryFinding.provider).toBe("openai");
    expect(rows[0]?.counterpartFinding).toBeNull();
  });

  it("returns two solo rows when both providers flag different files", () => {
    const rows = classify(
      providerResponses({
        anthropic: [{ evidence: [{ path: "src/a.ts", startLine: 10, endLine: 10 }] }],
        openai: [{ evidence: [{ path: "src/b.ts", startLine: 10, endLine: 10 }] }],
      }),
    );
    expect(rows.map((row) => row.category).toSorted()).toEqual(["solo_anthropic", "solo_openai"]);
  });
});

describe("classifyDisagreements mismatched classification", () => {
  it("returns one mismatched row when severity differs on the same file and line", () => {
    const rows = classify(
      providerResponses({
        anthropic: [{ severity: "critical" }],
        openai: [{ severity: "medium" }],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe("mismatched_classification");
    expect(rows[0]?.primaryFinding.provider).toBe("anthropic");
  });

  it("returns one mismatched row when category differs on the same file and line", () => {
    const rows = classify(
      providerResponses({
        anthropic: [{ category: "security", severity: "high" }],
        openai: [{ category: "bug", severity: "high" }],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe("mismatched_classification");
    expect(rows[0]?.primaryFinding.provider).toBe("anthropic");
    expect(rows[0]?.counterpartFinding?.provider).toBe("openai");
  });

  it("returns no disagreement when severity and category match on the same file and line", () => {
    const rows = classify(
      providerResponses({
        anthropic: [{ severity: "high", category: "bug" }],
        openai: [{ severity: "high", category: "bug" }],
      }),
    );
    expect(rows).toEqual([]);
  });
});

describe("classifyDisagreements deduplication", () => {
  it("emits a mismatched pair only once", () => {
    const rows = classify(
      providerResponses({
        anthropic: [{ severity: "critical" }],
        openai: [{ severity: "low" }],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("12345678-anthropic-0");
  });
});

describe("classifyDisagreements edge cases", () => {
  it("returns empty rows for skipped provider responses", () => {
    expect(classify({ status: "skipped", reason: "no reviewable files" })).toEqual([]);
  });

  it("returns empty rows when perProvider is missing", () => {
    expect(classify({})).toEqual([]);
  });

  it("returns empty rows when only one provider is present", () => {
    expect(
      classify({
        perProvider: [
          {
            name: "anthropic",
            ok: true,
            output: { findings: [finding()] },
          },
        ],
      }),
    ).toEqual([]);
  });

  it("returns empty rows when both providers have empty findings arrays", () => {
    expect(classify(providerResponses({ anthropic: [], openai: [] }))).toEqual([]);
  });
});

describe("classifyDisagreements deterministic ID", () => {
  it("uses review short id, provider, and original finding index", () => {
    const rows = classify(
      providerResponses({
        anthropic: [
          { evidence: [{ path: "src/ignored.ts", startLine: 1, endLine: 1 }] },
          { evidence: [{ path: "src/target.ts", startLine: 1, endLine: 1 }] },
        ],
        openai: [],
      }),
    );
    expect(rows[1]?.id).toBe("12345678-anthropic-1");
  });
});

describe("redactSecrets", () => {
  it("redacts AWS access key ids", () => {
    expect(redactSecrets("id AKIA1234567890ABCDEF leaked")).toBe("id [REDACTED] leaked");
  });

  it("redacts JWTs", () => {
    const jwt = "eyJabcdefghijk.abcdefghijklmnopqrstuvwxyz.ABCDEFGHIJKLMNOPQRST";
    expect(redactSecrets(`token ${jwt}`)).toBe("token [REDACTED]");
  });

  it("leaves normal text unchanged", () => {
    expect(redactSecrets("no credentials here")).toBe("no credentials here");
  });

  it("redacts only embedded secret values in mixed content", () => {
    expect(
      redactSecrets(
        "prefix api_key=abcdefghijklmnopqrstuvwxyz123456 and password: abcdefghijklmnopqrstuvwx suffix",
      ),
    ).toBe("prefix api_key=[REDACTED] and password: [REDACTED] suffix");
  });
});
