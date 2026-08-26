// Kill-test core: labeled-target manifest, lenient output parsing, known-answer
// matching, program-rule scoring, and the PASS/FAIL gate (§2 of
// specs/SOLIDITY_AUDIT_MODE_SPEC.md). Pure logic — no network, no fs.
//
// GATE (verbatim from §2): the new full-contract mode must catch ≥2 of 3 known
// bugs that the slice mode MISSES or UNDER-RATES. If it doesn't, the spec is
// dead: record the result, close it, do not build §3.

import { z } from "zod";

export const severities = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof severities)[number];

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export function severityRank(severity: Severity): number {
  return SEVERITY_RANK[severity];
}

/** True when `observed` rates at least as severe as `expected`. */
export function severityAtLeast(observed: Severity | null, expected: Severity): boolean {
  return observed !== null && SEVERITY_RANK[observed] >= SEVERITY_RANK[expected];
}

/**
 * One known in-scope high-severity bug with its location at the vulnerable
 * commit — the "labeled data" of §2. Provenance fields are mandatory so a
 * kill-test result is always checkable against a public report.
 */
export const knownBugSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  file: z.string(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  expectedSeverity: z.enum(["critical", "high"]),
});

export type KnownBug = z.infer<typeof knownBugSchema>;

export const targetManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  source: z.object({
    repo: z.string(),
    /** The commit whose tree is checked out under targets/<name>/. */
    commit: z.string().min(7),
    /** Public disclosure / contest report proving this is a KNOWN answer. */
    referenceUrl: z.string().url(),
  }),
  entryContracts: z.array(z.string()).min(1),
  /** Program inputs for Mode-C-style scoring: severity defs, scope, recovery policy. */
  programRules: z.string().min(1),
  knownBugs: z.array(knownBugSchema).min(1),
});

export type TargetManifest = z.infer<typeof targetManifestSchema>;

/** Minimal evidence-bearing shape shared by both modes' findings. */
type EvidenceBearing = {
  evidence: readonly { path: string; startLine: number | null; endLine: number | null }[];
};

/**
 * Does a finding's evidence LOCATE the known bug — same file AND overlapping the
 * labeled line range? Localization is REQUIRED (audit-integrity fix): evidence
 * with no line numbers does NOT match. Naming the right file without locating the
 * bug is not "surfaced" — otherwise the audit arm (which emits broad findings and
 * whose evidence lines default to null) could clear the gate by gesturing at the
 * file with a self-declared high severity, inflating the pass rate. Both arms are
 * held to the same bar. Path is matched by suffix in either direction (or equal
 * basename) so a leading-dir difference doesn't break a genuine localized match,
 * but a loose path match alone never counts — line overlap is still required.
 */
export function matchesBug(finding: EvidenceBearing, bug: KnownBug): boolean {
  const bugBase = bug.file.split("/").pop();
  for (const evidence of finding.evidence) {
    const evBase = evidence.path.split("/").pop();
    const pathMatch =
      evidence.path.endsWith(bug.file) ||
      bug.file.endsWith(evidence.path) ||
      (evBase !== undefined && evBase === bugBase);
    if (!pathMatch) {
      continue;
    }
    if (evidence.startLine === null) {
      continue; // no localization → not surfaced
    }
    const start = evidence.startLine;
    const end = evidence.endLine ?? start;
    if (start <= bug.lineEnd && end >= bug.lineStart) {
      return true;
    }
  }
  return false;
}

/** Highest severity among findings matching the bug; null when not surfaced. */
export function observedSeverityFor(
  findings: readonly (EvidenceBearing & { severity: Severity })[],
  bug: KnownBug,
): Severity | null {
  let best: Severity | null = null;
  for (const finding of findings) {
    if (!matchesBug(finding, bug)) {
      continue;
    }
    if (best === null || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[best]) {
      best = finding.severity;
    }
  }
  return best;
}

// --- Lenient parse of the audit mode's JSON output --------------------------
// Same tolerance philosophy as reviewOutputSchema (#134): an omitted or off-
// enum factor degrades to its default rather than nuking the whole run. A
// missing boolean reads as FALSE — i.e. fails the factor — which is the
// conservative direction for PURSUE scoring.

export const auditFindingSchema = z.object({
  title: z.string(),
  category: z.string().catch("security"),
  severity: z.enum(severities).catch("medium"),
  confidence: z.enum(["high", "medium", "low"]).catch("medium"),
  evidence: z
    .array(
      z.object({
        path: z.string(),
        startLine: z.number().int().positive().nullable().default(null),
        endLine: z.number().int().positive().nullable().default(null),
        symbol: z.string().nullable().default(null),
        quote: z.string().nullable().default(null),
      }),
    )
    .default([]),
  reasoning: z.string().default(""),
  triggerRole: z.string().default("unspecified"),
  preconditions: z.string().default("unspecified"),
  unprivilegedReachable: z.boolean().optional().default(false),
  recoverableUnder1hr: z.boolean().optional().default(false),
  inScope: z.boolean().optional().default(false),
  duplicateOf: z.string().nullable().optional().default(null),
});

export const auditOutputSchema = z.object({
  // PER-FINDING tolerance (#134 philosophy at the right granularity): one
  // malformed finding degrades ITSELF instead of nuking siblings. Whole-array
  // `.catch([])` was removed after the live e2e run: a 5k-output-token response
  // scored as zero findings because ONE bad element voided the entire array
  // silently. The catch-salvage keeps rejection VISIBLE as a droppable
  // placeholder finding.
  findings: z.array(
    auditFindingSchema.catch((ctx) => {
      const input = ctx.input;
      const title =
        typeof input === "object" &&
        input !== null &&
        typeof (input as { title?: unknown }).title === "string"
          ? (input as { title: string }).title
          : "(unparseable finding)";
      return {
        title,
        category: "security",
        severity: "low",
        confidence: "low",
        evidence: [],
        reasoning: "finding failed lenient parse — salvaged placeholder; inspect raw output",
        triggerRole: "unspecified",
        preconditions: "unspecified",
        unprivilegedReachable: false,
        recoverableUnder1hr: false,
        inScope: false,
        duplicateOf: null,
      };
    }),
  ),
  // `.catch` (not `.default`): the model sometimes returns `inspected` as a
  // string summary; a wrong TYPE must degrade to the empty default rather than
  // throw and nuke the whole finding-set (which would false-FAIL the gate).
  inspected: z
    .object({ files: z.array(z.string()).default([]), notes: z.array(z.string()).default([]) })
    .catch({ files: [], notes: [] }),
});

export type AuditFinding = z.infer<typeof auditFindingSchema>;
export type AuditOutput = z.infer<typeof auditOutputSchema>;

export type Verdict = "PURSUE" | "DROP";

export type ScoredVerdict = {
  verdict: Verdict;
  reason: string;
};

/**
 * Program-rule scoring (spec §3 component C, computed at finding time).
 * A finding must pass ALL four factors to be PURSUEd; any failure drops it
 * WITH its reason — these are exactly the factors that killed every Puffer #355
 * candidate per the spec.
 */
export function scoreAuditFinding(finding: AuditFinding): ScoredVerdict {
  if (!finding.unprivilegedReachable) {
    return { verdict: "DROP", reason: "not reachable without a privileged role" };
  }
  if (finding.recoverableUnder1hr) {
    return {
      verdict: "DROP",
      reason: "recoverable within the ~1-hour damage cap (measures/recovery policy)",
    };
  }
  if (!finding.inScope) {
    return { verdict: "DROP", reason: "out of scope under the target program rules" };
  }
  if (finding.duplicateOf !== null) {
    return {
      verdict: "DROP",
      reason: `likely duplicate of prior public finding: ${finding.duplicateOf}`,
    };
  }
  return { verdict: "PURSUE", reason: "passes all four program-rule factors" };
}

// --- Per-target outcome + gate ----------------------------------------------

export type ArmOutcome = {
  caught: boolean;
  observedSeverity: Severity | null;
};

export type TargetOutcome = {
  targetName: string;
  sliceArm: ArmOutcome;
  auditArm: ArmOutcome;
  /** Slice arm missed the bug entirely OR surfaced it below expected severity. */
  sliceMissedOrUnderRated: boolean;
  /** New mode surfaced the bug at >= expected severity. */
  auditSurfacedCorrectly: boolean;
  countsTowardGate: boolean;
  perBug: {
    bugId: string;
    slice: ArmOutcome;
    audit: ArmOutcome;
    auditVerdicts: ScoredVerdict[];
  }[];
};

function armForBug(
  findings: readonly (EvidenceBearing & { severity: Severity })[],
  bug: KnownBug,
): ArmOutcome {
  const observed = observedSeverityFor(findings, bug);
  return { caught: observed !== null, observedSeverity: observed };
}

/**
 * Evaluate one labeled target across both arms. A target contributes to the
 * gate iff at least one known bug was missed-or-under-rated by the SLICE arm
 * AND surfaced at correct severity by the AUDIT arm.
 */
export function evaluateTarget(args: {
  targetName: string;
  sliceFindings: readonly (EvidenceBearing & { severity: Severity })[];
  auditFindings: readonly (AuditFinding & { severity: Severity })[];
  bugs: readonly KnownBug[];
}): TargetOutcome {
  const perBug = args.bugs.map((bug) => {
    const slice = armForBug(args.sliceFindings, bug);
    const auditFindings = args.auditFindings.filter((f) => matchesBug(f, bug));
    const audit = armForBug(args.auditFindings, bug);
    return {
      bugId: bug.id,
      slice,
      audit,
      auditVerdicts: auditFindings.map(scoreAuditFinding),
    };
  });
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
  return {
    targetName: args.targetName,
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
    countsTowardGate: sliceMissedOrUnderRated && auditSurfacedCorrectly,
    perBug,
  };
}

export type GateDecision = {
  pass: boolean;
  passedTargets: number;
  totalTargets: number;
  reason: string;
};

/**
 * THE §2 GATE. Requires ≥3 labeled targets (fewer cannot falsify the premise)
 * and ≥2 where the new mode out-recalls/correctly-scores what the slice mode
 * missed or under-rated.
 */
export function evaluateGate(outcomes: readonly TargetOutcome[]): GateDecision {
  const totalTargets = outcomes.length;
  const passedTargets = outcomes.filter((o) => o.countsTowardGate).length;
  if (totalTargets < 3) {
    return {
      pass: false,
      passedTargets,
      totalTargets,
      reason: `${totalTargets} labeled target(s) present — §2 requires all 3 before the gate can be evaluated`,
    };
  }
  if (passedTargets >= 2) {
    return {
      pass: true,
      passedTargets,
      totalTargets,
      reason: `new mode caught ${passedTargets}/${totalTargets} known bugs the slice mode missed or under-rated — premise holds, §3 authorized`,
    };
  }
  return {
    pass: false,
    passedTargets,
    totalTargets,
    reason: `new mode caught only ${passedTargets}/${totalTargets} — STOP: record the result and close the spec`,
  };
}
