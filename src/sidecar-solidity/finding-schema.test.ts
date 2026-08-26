import { describe, it, expect } from "vitest";
import {
  auditOutputSchema,
  coerceScalarDrift,
  lenientParseFindings,
  severityAtLeast,
  severityRank,
} from "./finding-schema.js";

describe("severity helpers", () => {
  it("ranks critical > high > medium > low", () => {
    expect(severityRank("critical")).toBeGreaterThan(severityRank("high"));
    expect(severityRank("medium")).toBeGreaterThan(severityRank("low"));
  });

  it("severityAtLeast is false for a null observation; accepts equal-or-higher only", () => {
    expect(severityAtLeast(null, "high")).toBe(false);
    expect(severityAtLeast("critical", "high")).toBe(true);
    expect(severityAtLeast("medium", "high")).toBe(false);
  });
});

describe("coerceScalarDrift (#6b)", () => {
  it("coerces string-typed numbers and booleans field-by-field", () => {
    const coerced = coerceScalarDrift({
      title: "t",
      startLine: "42",
      unprivilegedReachable: "true",
      inScope: "false",
      nested: { endLine: "7" },
    }) as Record<string, unknown>;
    expect(coerced["startLine"]).toBe(42);
    expect(coerced["unprivilegedReachable"]).toBe(true);
    expect(coerced["inScope"]).toBe(false);
    expect((coerced["nested"] as Record<string, unknown>)["endLine"]).toBe(7);
    // Unknown string fields pass through untouched:
    expect(coerced["title"]).toBe("t");
  });
});

describe("auditOutputSchema — lenient parse", () => {
  it("defaults missing advisory factors to conservative values", () => {
    const parsed = auditOutputSchema.parse({
      findings: [{ title: "t" }],
      inspected: {},
    });
    expect(parsed.findings[0]?.unprivilegedReachable).toBe(false);
    expect(parsed.findings[0]?.inScope).toBe(false);
  });

  it("degrades an off-enum severity instead of throwing", () => {
    const parsed = auditOutputSchema.safeParse({
      findings: [{ title: "t", severity: "apocalyptic" }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("lenientParseFindings — per-finding salvage with raw preservation", () => {
  const good = { title: "good", evidence: [{ path: "a.sol", startLine: 1, endLine: 2 }] };

  it("keeps well-formed findings untouched", () => {
    const result = lenientParseFindings([good]);
    expect(result.findings).toHaveLength(1);
    expect(result.rejectedRaw).toHaveLength(0);
  });

  it("salvages a malformed finding as a visible placeholder AND preserves its raw", () => {
    // Title of the wrong TYPE makes this truly unparseable (unknown keys alone
    // would just be stripped by zod, which is fine).
    const bad = { title: 42, nonsense: true };
    const result = lenientParseFindings([bad]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.title).toBe("(unparseable finding)"); // no usable title -> visible placeholder
    expect(result.findings[0]?.evidence).toEqual([]); // placeholder has no fake citations
    expect(result.rejectedRaw[0]?.raw).toEqual(bad); // RAW preserved for the report
  });

  it("never lets one bad element void siblings (live-e2e regression)", () => {
    const result = lenientParseFindings([good, { totally: "broken" }, good]);
    expect(result.findings).toHaveLength(3); // good + placeholder + good
    expect(result.rejectedRaw).toHaveLength(1);
  });
});
