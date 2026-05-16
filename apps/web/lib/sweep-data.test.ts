import { describe, expect, it } from "vitest";
import { extractAgreedFindings, extractFindingsByIndex } from "./sweep-data";

function validFinding(overrides: Record<string, unknown> = {}) {
  return {
    title: "Null pointer in handler",
    category: "bug",
    severity: "high",
    reasoning: "rationale",
    recommendation: "guard the access",
    evidence: [{ path: "src/handler.ts", startLine: 42, endLine: 50 }],
    ...overrides,
  };
}

describe("extractAgreedFindings", () => {
  it("returns the agreed array on the production shape", () => {
    const out = extractAgreedFindings({
      mode: "unanimous",
      agreed: [validFinding(), validFinding({ title: "Race in cache" })],
      disagreements: [],
      degraded: false,
      degradedReason: null,
    });
    expect(out).not.toBeNull();
    expect(out).toHaveLength(2);
    expect(out![0]!.title).toBe("Null pointer in handler");
  });

  it("returns [] on the production shape with zero agreed findings", () => {
    const out = extractAgreedFindings({
      mode: "unanimous",
      agreed: [],
      disagreements: [],
      degraded: false,
      degradedReason: null,
    });
    expect(out).toEqual([]);
  });

  it("returns null on the pending stub shape", () => {
    expect(extractAgreedFindings({ status: "pending" })).toBeNull();
  });

  it("returns null on the skipped/error stub shapes", () => {
    expect(extractAgreedFindings({ status: "skipped" })).toBeNull();
    expect(extractAgreedFindings({ status: "error" })).toBeNull();
  });

  it("returns null on non-object input", () => {
    expect(extractAgreedFindings(null)).toBeNull();
    expect(extractAgreedFindings(undefined)).toBeNull();
    expect(extractAgreedFindings("string")).toBeNull();
    expect(extractAgreedFindings(42)).toBeNull();
    expect(extractAgreedFindings([])).toBeNull();
  });

  it("returns null when any single finding is malformed (defense in depth)", () => {
    const out = extractAgreedFindings({
      agreed: [validFinding(), { title: "incomplete" }],
    });
    expect(out).toBeNull();
  });

  it("returns null when evidence is empty (closure detection has no path)", () => {
    const out = extractAgreedFindings({
      agreed: [validFinding({ evidence: [] })],
    });
    expect(out).toBeNull();
  });

  it("accepts findings with null startLine/endLine (no-line evidence is valid)", () => {
    const out = extractAgreedFindings({
      agreed: [validFinding({ evidence: [{ path: "src/a.ts", startLine: null, endLine: null }] })],
    });
    expect(out).not.toBeNull();
    expect(out).toHaveLength(1);
  });
});

describe("extractFindingsByIndex", () => {
  it("indexes findings by their position in the agreed array", () => {
    const out = extractFindingsByIndex({
      agreed: [
        validFinding({ title: "first" }),
        validFinding({ title: "second" }),
        validFinding({ title: "third" }),
      ],
    });
    expect(out).not.toBeNull();
    expect(out!.size).toBe(3);
    expect(out!.get(0)?.title).toBe("first");
    expect(out!.get(1)?.title).toBe("second");
    expect(out!.get(2)?.title).toBe("third");
  });

  it("forwards null when the underlying extraction fails", () => {
    expect(extractFindingsByIndex({ status: "pending" })).toBeNull();
  });

  it("returns an empty map for zero agreed findings (distinct from null = malformed)", () => {
    const out = extractFindingsByIndex({ agreed: [] });
    expect(out).not.toBeNull();
    expect(out!.size).toBe(0);
  });
});
