import { describe, it, expect } from "vitest";
import {
  evaluateGate,
  evaluateTarget,
  matchesBug,
  observedSeverityFor,
  validateArmSplit,
  type KnownBug,
  type TargetOutcome,
} from "./kill-gate.js";

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
});

describe("matchesBug — ported spike-runner semantics", () => {
  it("matches evidence overlapping the labeled range in the same file", () => {
    const finding = { evidence: [ev("src/contracts/Vault.sol", 42, 50)] };
    expect(matchesBug(finding, bug)).toBe(true);
  });

  it("does not match a different file even on overlapping lines", () => {
    expect(matchesBug({ evidence: [ev("contracts/Other.sol", 42, 50)] }, bug)).toBe(false);
  });

  it("does not match non-overlapping ranges", () => {
    expect(matchesBug({ evidence: [ev("contracts/Vault.sol", 10, 20)] }, bug)).toBe(false);
  });
});

describe("observedSeverityFor", () => {
  const f = (
    severity: "critical" | "high" | "medium" | "low",
    path = "pkg/contracts/Vault.sol",
  ) => ({
    severity,
    evidence: [ev(path, 45, 45)],
  });

  it("returns null when nothing matches; highest severity otherwise", () => {
    expect(observedSeverityFor([f("critical", "Other.sol")], bug)).toBeNull();
    expect(observedSeverityFor([f("low"), f("critical")], bug)).toBe("critical");
  });
});

// --- Gate fixtures -----------------------------------------------------------

function outcomeWith(overrides: {
  name?: string;
  baselineStatus?: "ran" | "errored" | "skipped";
  auditStatus?: "ran" | "errored" | "skipped";
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
            title: "t",
            severity: overrides.auditSeverity,
            evidence: [ev("pkg/contracts/Vault.sol", 42, 55)],
          },
        ]
      : [];
  return evaluateTarget({
    targetName: overrides.name ?? "target",
    baselineStatus: overrides.baselineStatus ?? "ran",
    auditStatus: overrides.auditStatus ?? "ran",
    sliceFindings,
    auditFindings,
    bugs: [bug],
  });
}

describe("evaluateTarget — C2 arm-status exclusion", () => {
  it("counts toward gate when slice under-rates and audit scores correctly", () => {
    const outcome = outcomeWith({
      sliceCaught: true,
      sliceSeverity: "low",
      auditCaught: true,
      auditSeverity: "high",
    });
    expect(outcome.countsTowardGate).toBe(true);
    expect(outcome.excludedFromGate).toBe(false);
  });

  it("EXCLUDES a target whose baseline errored (broken baseline is not a miss)", () => {
    const outcome = outcomeWith({
      sliceCaught: false, // would have been a manufactured "miss"
      auditCaught: true,
      auditSeverity: "high",
      baselineStatus: "errored",
    });
    expect(outcome.excludedFromGate).toBe(true);
    expect(outcome.exclusionReason).toContain("baseline errored");
    expect(outcome.countsTowardGate).toBe(false);
  });

  it("EXCLUDES a target whose baseline was cost-skipped", () => {
    const outcome = outcomeWith({
      sliceCaught: false,
      auditCaught: true,
      auditSeverity: "critical",
      baselineStatus: "skipped",
    });
    expect(outcome.excludedFromGate).toBe(true);
    expect(outcome.countsTowardGate).toBe(false);
  });

  it("EXCLUDES a target whose audit arm errored (can't confirm the catch)", () => {
    const outcome = outcomeWith({
      sliceCaught: true,
      sliceSeverity: "low",
      auditStatus: "errored",
    });
    expect(outcome.excludedFromGate).toBe(true);
  });

  it("does NOT count when both arms ran and both caught at correct severity (no delta)", () => {
    const outcome = outcomeWith({
      sliceCaught: true,
      sliceSeverity: "high",
      auditCaught: true,
      auditSeverity: "high",
    });
    expect(outcome.countsTowardGate).toBe(false);
  });
});

describe("validateArmSplit — CLOSURE_UPGRADE item 4", () => {
  it("valid when the discriminating file is in audit and absent from slice", () => {
    expect(
      validateArmSplit({
        discriminatingFiles: ["contracts/Oracle.sol"],
        sliceArmFiles: ["contracts/Vault.sol"],
        auditArmFiles: ["contracts/Vault.sol", "contracts/Oracle.sol"],
      }).valid,
    ).toBe(true);
  });

  it("invalid when the discriminating file is missing from the audit arm", () => {
    const r = validateArmSplit({
      discriminatingFiles: ["contracts/Oracle.sol"],
      sliceArmFiles: ["contracts/Vault.sol"],
      auditArmFiles: ["contracts/Vault.sol"],
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("missing from audit arm");
  });

  it("invalid when the discriminating file leaked into the slice arm", () => {
    const r = validateArmSplit({
      discriminatingFiles: ["contracts/Oracle.sol"],
      sliceArmFiles: ["contracts/Vault.sol", "contracts/Oracle.sol"],
      auditArmFiles: ["contracts/Vault.sol", "contracts/Oracle.sol"],
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("leaked into slice arm");
  });
});

describe("evaluateTarget — discriminating-file split (CLOSURE_UPGRADE item 4)", () => {
  const crossBug: KnownBug = {
    id: "cross-1",
    description: "backing over-report only visible with the oracle sibling",
    file: "contracts/Vault.sol",
    lineStart: 40,
    lineEnd: 55,
    expectedSeverity: "high",
    discriminatingFiles: ["contracts/Oracle.sol"],
  };
  const auditCaught = [
    { title: "t", severity: "high" as const, evidence: [ev("contracts/Vault.sol", 42, 55)] },
  ];

  it("counts when the split is valid, slice misses, audit catches", () => {
    const outcome = evaluateTarget({
      targetName: "t",
      baselineStatus: "ran",
      auditStatus: "ran",
      sliceFindings: [],
      auditFindings: auditCaught,
      bugs: [crossBug],
      sliceArmFiles: ["contracts/Vault.sol"],
      auditArmFiles: ["contracts/Vault.sol", "contracts/Oracle.sol"],
    });
    expect(outcome.armsSplitValid).toBe(true);
    expect(outcome.excludedFromGate).toBe(false);
    expect(outcome.countsTowardGate).toBe(true);
  });

  it("EXCLUDES a target whose discriminating file never reached the audit arm", () => {
    const outcome = evaluateTarget({
      targetName: "t",
      baselineStatus: "ran",
      auditStatus: "ran",
      sliceFindings: [],
      auditFindings: auditCaught,
      bugs: [crossBug],
      sliceArmFiles: ["contracts/Vault.sol"],
      auditArmFiles: ["contracts/Vault.sol"], // Oracle.sol missing
    });
    expect(outcome.armsSplitValid).toBe(false);
    expect(outcome.excludedFromGate).toBe(true);
    expect(outcome.exclusionReason).toContain("split invalid");
    expect(outcome.countsTowardGate).toBe(false);
  });

  it("EXCLUDES a target whose discriminating file leaked into the slice arm", () => {
    const outcome = evaluateTarget({
      targetName: "t",
      baselineStatus: "ran",
      auditStatus: "ran",
      sliceFindings: [],
      auditFindings: auditCaught,
      bugs: [crossBug],
      sliceArmFiles: ["contracts/Vault.sol", "contracts/Oracle.sol"],
      auditArmFiles: ["contracts/Vault.sol", "contracts/Oracle.sol"],
    });
    expect(outcome.excludedFromGate).toBe(true);
    expect(outcome.countsTowardGate).toBe(false);
  });

  it("falls back to the legacy single `file` as the discriminating file when unset", () => {
    // `bug` has no discriminatingFiles → its `file` (Vault.sol) is the split key.
    const outcome = evaluateTarget({
      targetName: "t",
      baselineStatus: "ran",
      auditStatus: "ran",
      sliceFindings: [],
      auditFindings: auditCaught,
      bugs: [bug],
      sliceArmFiles: ["contracts/Entry.sol"],
      auditArmFiles: ["contracts/Entry.sol", "contracts/Vault.sol"],
    });
    expect(outcome.armsSplitValid).toBe(true);
    expect(outcome.excludedFromGate).toBe(false);
  });
});

describe("evaluateGate — THE §2 GATE (C2-hardened)", () => {
  it("cannot pass with fewer than 3 fully-run targets", () => {
    const decision = evaluateGate([
      outcomeWith({ sliceCaught: false, auditCaught: true, auditSeverity: "high" }),
    ]);
    expect(decision.pass).toBe(false);
    expect(decision.reason).toContain("3 fully-run targets");
  });

  it("PASSes at exactly 2 of 3 gate-relevant targets (all arms ran)", () => {
    const outcomes = [
      outcomeWith({ name: "a", sliceCaught: false, auditCaught: true, auditSeverity: "high" }),
      outcomeWith({ name: "b", sliceCaught: false, auditCaught: true, auditSeverity: "high" }),
      outcomeWith({ name: "c", sliceCaught: false, auditCaught: false }),
    ];
    const decision = evaluateGate(outcomes);
    expect(decision.pass).toBe(true);
    expect(decision.passedTargets).toBe(2);
  });

  it("does NOT pass when one broken-baseline target inflates the count to 2 (C2 regression)", () => {
    // Old behavior: errored baseline → sliceFindings=[] → "miss" → counts →
    // false PASS. New behavior: excluded, eligible=2 < 3.
    const outcomes = [
      outcomeWith({ name: "a", sliceCaught: false, auditCaught: true, auditSeverity: "high" }),
      outcomeWith({
        name: "broken-baseline",
        sliceCaught: false,
        auditCaught: true,
        auditSeverity: "critical",
        baselineStatus: "errored",
      }),
      outcomeWith({ name: "c", sliceCaught: false, auditCaught: false }),
    ];
    const decision = evaluateGate(outcomes);
    expect(decision.pass).toBe(false);
    expect(decision.eligibleTargets).toBe(2);
    expect(decision.reason).toContain("excluded");
  });

  it("FAILs at 1 of 3 and orders STOP + close the spec", () => {
    const outcomes = [
      outcomeWith({ name: "a", sliceCaught: false, auditCaught: true, auditSeverity: "high" }),
      outcomeWith({ name: "b", sliceCaught: false, auditCaught: false }),
      outcomeWith({ name: "c", sliceCaught: false, auditCaught: false }),
    ];
    expect(evaluateGate(outcomes).pass).toBe(false);
    expect(evaluateGate(outcomes).reason).toContain("STOP");
  });
});
