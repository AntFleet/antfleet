// Kill-test gate evaluation (labeled-target premise measurement) — the ONLY
// consumer of this module is scripts/solidity-killtest.ts. Renamed from
// killtest.ts per REWORK_PROMPT item 8 so the load-bearing finding contract
// (finding-schema.ts / scoring.ts) doesn't read as test-only.
//
// C2 FIX (REWORK_PROMPT item 4): a target whose baseline arm did not
// successfully complete is EXCLUDED from the gate — a broken/cost-skipped
// baseline previously manufactured "missed by slice" and inflated the gate
// toward a false "premise holds" PASS.

import { z } from "zod";
import { severityAtLeast, type Severity } from "./finding-schema.js";
export type { Severity };

/**
 * One known in-scope high-severity bug with its location at the vulnerable
 * commit — the labeled data of the kill test. Provenance fields are mandatory
 * so results stay checkable against a public report.
 */
export const knownBugSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  file: z.string(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  expectedSeverity: z.enum(["critical", "high"]),
  /**
   * CLOSURE_UPGRADE item 4: the file(s) the bug's mechanism REQUIRES to be seen.
   * The audit arm must contain all of these and the slice arm none — otherwise
   * "closure helped" is unmeasurable (the Intuition confound, where the deciding
   * file was in neither arm). Optional for back-compat: legacy manifests carry
   * only `file`, which is used as the sole discriminating file when this is absent.
   */
  discriminatingFiles: z.array(z.string().min(1)).min(1).optional(),
});

export type KnownBug = z.infer<typeof knownBugSchema>;

export const targetManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  source: z.object({
    repo: z.string(),
    commit: z.string().min(7),
    referenceUrl: z.string().url(),
  }),
  entryContracts: z.array(z.string()).min(1),
  programRules: z.string().min(1),
  knownBugs: z.array(knownBugSchema).min(1),
});

export type TargetManifest = z.infer<typeof targetManifestSchema>;

type EvidenceBearing = {
  evidence: readonly { path: string; startLine: number | null; endLine: number | null }[];
};

/** Does a finding's evidence point inside the known bug's file:line range? */
export function matchesBug(finding: EvidenceBearing, bug: KnownBug): boolean {
  for (const evidence of finding.evidence) {
    if (!evidence.path.endsWith(bug.file)) {
      continue;
    }
    const start = evidence.startLine ?? 0;
    const end = evidence.endLine ?? start;
    if (start <= bug.lineEnd && end >= bug.lineStart) {
      return true;
    }
    if (evidence.startLine === null && evidence.endLine === null) {
      return true;
    }
  }
  return false;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export function observedSeverityFor(
  findings: readonly (EvidenceBearing & { severity: Severity })[],
  bug: KnownBug,
): Severity | null {
  let best: Severity | null = null;
  for (const finding of findings) {
    if (!matchesBug(finding, bug)) {
      continue;
    }
    if (best === null || finding.severity === "critical" || best !== "critical") {
      // max-severity fold; explicit for readability
      if (best === null || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[best]) {
        best = finding.severity;
      }
    }
  }
  return best;
}

/** Suffix-tolerant membership: repo-relative paths vs. shorter labeled paths. */
export function fileInList(file: string, list: readonly string[]): boolean {
  return list.some((p) => p.endsWith(file) || file.endsWith(p));
}

/**
 * CLOSURE_UPGRADE item 4: validate that the discriminating file(s) are in the
 * audit arm and NOT in the slice arm. If they aren't, the target cannot measure
 * whether closure helped, so it is INVALID for the gate (not scored).
 */
export function validateArmSplit(args: {
  discriminatingFiles: readonly string[];
  sliceArmFiles: readonly string[];
  auditArmFiles: readonly string[];
}): { valid: boolean; reason: string | null } {
  const missingFromAudit = args.discriminatingFiles.filter(
    (d) => !fileInList(d, args.auditArmFiles),
  );
  const leakedToSlice = args.discriminatingFiles.filter((d) => fileInList(d, args.sliceArmFiles));
  if (missingFromAudit.length === 0 && leakedToSlice.length === 0) {
    return { valid: true, reason: null };
  }
  return {
    valid: false,
    reason:
      `discriminating-file split invalid — missing from audit arm: [${missingFromAudit.join(", ")}]; ` +
      `leaked into slice arm: [${leakedToSlice.join(", ")}]`,
  };
}

export type ArmOutcome = {
  caught: boolean;
  observedSeverity: Severity | null;
};

export type ArmRunStatus = "ran" | "errored" | "skipped";

export type TargetOutcome = {
  targetName: string;
  /** C2: arms that did not successfully complete EXCLUDE the target from the gate. */
  baselineRan: boolean;
  auditRan: boolean;
  /** CLOSURE_UPGRADE item 4: discriminating file(s) correctly split across arms. */
  armsSplitValid: boolean;
  excludedFromGate: boolean;
  exclusionReason: string | null;
  sliceArm: ArmOutcome;
  auditArm: ArmOutcome;
  sliceMissedOrUnderRated: boolean;
  auditSurfacedCorrectly: boolean;
  countsTowardGate: boolean;
  perBug: {
    bugId: string;
    slice: ArmOutcome;
    audit: ArmOutcome;
  }[];
};

function armForBug(
  findings: readonly (EvidenceBearing & { severity: Severity })[],
  bug: KnownBug,
): ArmOutcome {
  const observed = observedSeverityFor(findings, bug);
  return { caught: observed !== null, observedSeverity: observed };
}

export function evaluateTarget(args: {
  targetName: string;
  baselineStatus: ArmRunStatus;
  auditStatus: ArmRunStatus;
  sliceFindings: readonly (EvidenceBearing & { severity: Severity })[];
  auditFindings: readonly (EvidenceBearing & { severity: Severity })[];
  bugs: readonly KnownBug[];
  /**
   * CLOSURE_UPGRADE item 4: the actual file path lists each arm saw. When both
   * are supplied, the discriminating-file split is validated and an invalid
   * split EXCLUDES the target from the gate. Omitted → split validation skipped
   * (armsSplitValid defaults true) for legacy/unit callers.
   */
  sliceArmFiles?: readonly string[] | undefined;
  auditArmFiles?: readonly string[] | undefined;
}): TargetOutcome {
  const perBug = args.bugs.map((bug) => ({
    bugId: bug.id,
    slice: armForBug(args.sliceFindings, bug),
    audit: armForBug(args.auditFindings, bug),
  }));
  const sliceMissedOrUnderRated = args.bugs.some((bug, i) => {
    const outcome = perBug[i];
    if (outcome === undefined || !outcome.slice.caught) {
      return true; // missed outright
    }
    return !severityAtLeast(outcome.slice.observedSeverity, bug.expectedSeverity);
  });
  const auditSurfacedCorrectly = args.bugs.some((bug, i) => {
    const outcome = perBug[i];
    return (
      outcome !== undefined && severityAtLeast(outcome.audit.observedSeverity, bug.expectedSeverity)
    );
  });

  const baselineRan = args.baselineStatus === "ran";
  const auditRan = args.auditStatus === "ran";

  // CLOSURE_UPGRADE item 4: validate the discriminating-file split when arm file
  // lists are supplied. Legacy manifests carry only `file`; use it as the sole
  // discriminating file then.
  let armsSplitValid = true;
  let splitReason: string | null = null;
  if (args.sliceArmFiles !== undefined && args.auditArmFiles !== undefined) {
    const discriminatingFiles = args.bugs.flatMap((b) => b.discriminatingFiles ?? [b.file]);
    const split = validateArmSplit({
      discriminatingFiles,
      sliceArmFiles: args.sliceArmFiles,
      auditArmFiles: args.auditArmFiles,
    });
    armsSplitValid = split.valid;
    splitReason = split.reason;
  }

  let excludedFromGate = false;
  let exclusionReason: string | null = null;
  if (!baselineRan || !auditRan) {
    excludedFromGate = true;
    exclusionReason = `baseline ${args.baselineStatus}, audit ${args.auditStatus} — target excluded from gate (C2: an incomplete arm must not count as a miss)`;
  } else if (!armsSplitValid) {
    excludedFromGate = true;
    exclusionReason = splitReason;
  }

  return {
    targetName: args.targetName,
    baselineRan,
    auditRan,
    armsSplitValid,
    excludedFromGate,
    exclusionReason,
    sliceArm: {
      caught: perBug.some((p) => p.slice.caught),
      observedSeverity: perBug.map((p) => p.slice.observedSeverity).find((s) => s !== null) ?? null,
    },
    auditArm: {
      caught: perBug.some((p) => p.audit.caught),
      observedSeverity: perBug.map((p) => p.audit.observedSeverity).find((s) => s !== null) ?? null,
    },
    sliceMissedOrUnderRated,
    auditSurfacedCorrectly,
    countsTowardGate: !excludedFromGate && sliceMissedOrUnderRated && auditSurfacedCorrectly,
    perBug,
  };
}

export type GateDecision = {
  pass: boolean;
  passedTargets: number;
  eligibleTargets: number;
  totalTargets: number;
  reason: string;
};

/**
 * THE §2 GATE (C2-hardened). Requires ≥3 labeled targets where BOTH arms ran
 * successfully; errored/skipped-arm targets are excluded entirely.
 */
export function evaluateGate(outcomes: readonly TargetOutcome[]): GateDecision {
  const totalTargets = outcomes.length;
  const eligible = outcomes.filter((o) => !o.excludedFromGate);
  const eligibleTargets = eligible.length;
  const passedTargets = eligible.filter((o) => o.countsTowardGate).length;
  if (eligibleTargets < 3) {
    return {
      pass: false,
      passedTargets,
      eligibleTargets,
      totalTargets,
      reason:
        `${eligibleTargets}/${totalTargets} targets have BOTH arms successfully run — §2 requires 3 fully-run targets before the gate can be evaluated` +
        (eligibleTargets < totalTargets ? " (excluded: see per-target exclusion reasons)" : ""),
    };
  }
  if (passedTargets >= 2) {
    return {
      pass: true,
      passedTargets,
      eligibleTargets,
      totalTargets,
      reason: `new mode caught ${passedTargets}/${eligibleTargets} known bugs the slice mode missed or under-rated — premise holds`,
    };
  }
  return {
    pass: false,
    passedTargets,
    eligibleTargets,
    totalTargets,
    reason: `new mode caught only ${passedTargets}/${eligibleTargets} — STOP: record the result and close the spec`,
  };
}
