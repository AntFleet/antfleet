import { describe, it, expect } from "vitest";
import {
  auditOutputSchema,
  evaluateGate,
  evaluateTarget,
  matchesBug,
  observedSeverityFor,
  scoreAuditFinding,
  severityAtLeast,
  severityRank,
  type AuditFinding,
  type KnownBug,
  type TargetOutcome,
} from "./killtest.js";

const bug: KnownBug = {
  id: "known-1",
  description: "unprivileged withdraw drains vault",
  file: "contracts/Vault.sol",
  lineStart: 40,
  lineEnd: 55,
  expectedSeverity: "high",
};

const ev = (path: string, startLine: number | null, endLine: number | null) => ({
  path,
  startLine,
  endLine,
  symbol: null,
  quote: null,
});

// Shared PURSUE-passing audit finding fixture.
const base = {
  title: "t",
  unprivilegedReachable: true,
  recoverableUnder1hr: false,
  inScope: true,
  duplicateOf: null,
} as AuditFinding;

describe("severity helpers", () => {
  it("ranks critical > high > medium > low", () => {
    expect(severityRank("critical")).toBeGreaterThan(severityRank("high"));
    expect(severityRank("high")).toBeGreaterThan(severityRank("medium"));
    expect(severityRank("medium")).toBeGreaterThan(severityRank("low"));
  });

  it("severityAtLeast is false for a null observation", () => {
    expect(severityAtLeast(null, "high")).toBe(false);
  });

  it("severityAtLeast accepts equal or higher ratings only", () => {
    expect(severityAtLeast("critical", "high")).toBe(true);
    expect(severityAtLeast("high", "high")).toBe(true);
    expect(severityAtLeast("medium", "high")).toBe(false);
  });
});

describe("matchesBug — ported spike-runner semantics (same matcher for both arms)", () => {
  it("matches evidence overlapping the labeled range in the same file", () => {
    const finding = { evidence: [ev("src/contracts/Vault.sol", 42, 50)] };
    expect(matchesBug(finding, bug)).toBe(true);
  });

  it("does not match a different file even on overlapping lines", () => {
    const finding = { evidence: [ev("contracts/Other.sol", 42, 50)] };
    expect(matchesBug(finding, bug)).toBe(false);
  });

  it("does NOT match a null line range — naming the file is not locating the bug (integrity fix)", () => {
    const finding = { evidence: [ev("x/contracts/Vault.sol", null, null)] };
    expect(matchesBug(finding, bug)).toBe(false);
  });

  it("matches by basename when the model omits leading dirs, IF lines overlap", () => {
    const finding = { evidence: [ev("Vault.sol", 42, 50)] };
    expect(matchesBug(finding, bug)).toBe(true);
  });

  it("basename match still requires line overlap (no free pass)", () => {
    const finding = { evidence: [ev("Vault.sol", null, null)] };
    expect(matchesBug(finding, bug)).toBe(false);
  });

  it("does not match non-overlapping ranges", () => {
    const finding = { evidence: [ev("contracts/Vault.sol", 10, 20)] };
    expect(matchesBug(finding, bug)).toBe(false);
  });
});

describe("observedSeverityFor — takes the max severity among matching findings", () => {
  const f = (
    severity: "critical" | "high" | "medium" | "low",
    path = "pkg/contracts/Vault.sol",
  ) => ({
    severity,
    evidence: [ev(path, 45, 45)],
  });

  it("returns null when nothing matches", () => {
    expect(observedSeverityFor([f("critical", "Other.sol")], bug)).toBeNull();
  });

  it("returns the highest matching severity", () => {
    expect(observedSeverityFor([f("low"), f("critical"), f("medium")], bug)).toBe("critical");
  });
});

describe("auditOutputSchema — lenient parse (#134 philosophy)", () => {
  it("defaults missing factors to conservative values", () => {
    const parsed = auditOutputSchema.parse({
      findings: [{ title: "t" }],
      inspected: {},
    });
    const finding = parsed.findings[0] as AuditFinding;
    // Missing booleans read FALSE -> fail the factor -> DROP. Conservative.
    expect(finding.unprivilegedReachable).toBe(false);
    expect(finding.inScope).toBe(false);
    expect(finding.duplicateOf).toBeNull();
  });

  it("degrades an off-enum severity instead of throwing", () => {
    const parsed = auditOutputSchema.safeParse({
      findings: [{ title: "t", severity: "apocalyptic" }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.findings[0]?.severity).toBe("medium");
    }
  });
});

describe("scoreAuditFinding — program-rule scoring (§3 component C shape)", () => {
  it("PURSUEs only when all four factors pass", () => {
    expect(scoreAuditFinding(base)).toEqual({
      verdict: "PURSUE",
      reason: "passes all four program-rule factors",
    });
  });

  it.each([
    [
      "unprivilegedReachable",
      { ...base, unprivilegedReachable: false },
      "not reachable without a privileged role",
    ],
    ["recoverableUnder1hr", { ...base, recoverableUnder1hr: true }, "recoverable within"],
    ["inScope", { ...base, inScope: false }, "out of scope"],
    ["duplicateOf", { ...base, duplicateOf: "Sherlock 2023 #12" }, "duplicate"],
  ] as const)("%s failure DROPs with its reason", (_field, finding, reasonFragment) => {
    const verdict = scoreAuditFinding(finding);
    expect(verdict.verdict).toBe("DROP");
    expect(verdict.reason).toContain(reasonFragment);
  });
});

// --- Gate fixtures -----------------------------------------------------------

function outcomeWith(overrides: {
  name?: string;
  sliceCaught?: boolean;
  sliceSeverity?: "critical" | "high" | "medium" | "low" | null;
  auditCaught?: boolean;
  auditSeverity?: "critical" | "high" | "medium" | "low" | null;
}): TargetOutcome {
  const sliceCaught = overrides.sliceCaught ?? false;
  const auditCaught = overrides.auditCaught ?? false;
  const sliceFindings =
    sliceCaught === true && overrides.sliceSeverity != null
      ? [{ severity: overrides.sliceSeverity, evidence: [ev("pkg/contracts/Vault.sol", 42, 55)] }]
      : [];
  const auditFindings =
    auditCaught === true && overrides.auditSeverity != null
      ? [
          {
            ...base,
            severity: overrides.auditSeverity,
            evidence: [ev("pkg/contracts/Vault.sol", 42, 55)],
          },
        ]
      : [];
  return evaluateTarget({
    targetName: overrides.name ?? "target",
    sliceFindings,
    auditFindings,
    bugs: [bug],
  });
}

describe("evaluateTarget", () => {
  it("counts toward gate when slice under-rates and audit scores correctly", () => {
    const outcome = outcomeWith({
      sliceCaught: true,
      sliceSeverity: "low",
      auditCaught: true,
      auditSeverity: "high",
    });
    expect(outcome.sliceMissedOrUnderRated).toBe(true);
    expect(outcome.auditSurfacedCorrectly).toBe(true);
    expect(outcome.countsTowardGate).toBe(true);
  });

  it("counts toward gate when the slice arm misses outright", () => {
    const outcome = outcomeWith({ sliceCaught: false, auditCaught: true, auditSeverity: "high" });
    expect(outcome.countsTowardGate).toBe(true);
  });

  it("does NOT count when both arms catch at correct severity (no delta)", () => {
    const outcome = outcomeWith({
      sliceCaught: true,
      sliceSeverity: "high",
      auditCaught: true,
      auditSeverity: "high",
    });
    expect(outcome.countsTowardGate).toBe(false);
  });

  it("does NOT count when the audit arm also under-rates", () => {
    const outcome = outcomeWith({
      sliceCaught: true,
      sliceSeverity: "low",
      auditCaught: true,
      auditSeverity: "medium",
    });
    expect(outcome.countsTowardGate).toBe(false);
  });

  it("does NOT count when the audit arm misses too (no recall upgrade anywhere)", () => {
    const outcome = outcomeWith({ sliceCaught: false, auditCaught: false });
    expect(outcome.countsTowardGate).toBe(false);
  });
});

describe("evaluateGate — THE §2 GATE", () => {
  it("cannot pass with fewer than 3 labeled targets", () => {
    const decision = evaluateGate([outcomeWith({ auditCaught: true, auditSeverity: "high" })]);
    expect(decision.pass).toBe(false);
    expect(decision.reason).toContain("requires all 3");
  });

  it("PASSes at exactly 2 of 3 gate-relevant targets", () => {
    const outcomes = [
      outcomeWith({ name: "a", sliceCaught: false, auditCaught: true, auditSeverity: "high" }),
      outcomeWith({ name: "b", sliceCaught: false, auditCaught: true, auditSeverity: "high" }),
      outcomeWith({ name: "c", sliceCaught: false, auditCaught: false }),
    ];
    const decision = evaluateGate(outcomes);
    expect(decision.pass).toBe(true);
    expect(decision.passedTargets).toBe(2);
    expect(decision.reason).toContain("§3 authorized");
  });

  it("FAILs at 1 of 3 and orders STOP + close the spec", () => {
    const outcomes = [
      outcomeWith({ name: "a", sliceCaught: false, auditCaught: true, auditSeverity: "high" }),
      outcomeWith({ name: "b", sliceCaught: false, auditCaught: false }),
      outcomeWith({ name: "c", sliceCaught: false, auditCaught: false }),
    ];
    const decision = evaluateGate(outcomes);
    expect(decision.pass).toBe(false);
    expect(decision.reason).toContain("STOP");
  });

  it("FAILs even at 3/3 caught-baseline targets (slice must have missed something first)", () => {
    const outcomes = [
      outcomeWith({
        name: "a",
        sliceCaught: true,
        sliceSeverity: "high",
        auditCaught: true,
        auditSeverity: "high",
      }),
      outcomeWith({
        name: "b",
        sliceCaught: true,
        sliceSeverity: "high",
        auditCaught: true,
        auditSeverity: "high",
      }),
      outcomeWith({
        name: "c",
        sliceCaught: true,
        sliceSeverity: "high",
        auditCaught: true,
        auditSeverity: "high",
      }),
    ];
    expect(evaluateGate(outcomes).pass).toBe(false);
  });
});
