// The finding output CONTRACT for the whole-contract Solidity sidecar.
// specs/SOLIDITY_SIDECAR_SPEC.md §3-C as reworked by REWORK_PROMPT.md:
// model-emitted booleans are ADVISORY METADATA ONLY — they never promote a
// finding to PURSUE. Promotion requires mechanical citation-grounding
// (scoring.ts groundFinding) plus an independent refuter pass (refuter.ts).
//
// Lenient-parse philosophy retained from #134, but applied at the RIGHT
// granularity: per-finding salvage with raw preservation, never silent zeros.

import { z } from "zod";

export const severities = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof severities)[number];

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
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
 * Field-by-field scalar-drift coercion BEFORE schema parse ("42" → 42,
 * "true" → true). REWORK_PROMPT item 6b: a bare .catch() placeholder was
 * discarding valid content on trivial type drift; coercion preserves it.
 * Unknown fields pass through untouched so nothing is silently stripped here.
 */
export function coerceScalarDrift(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") {
      const trimmed = value.trim().toLowerCase();
      if ((key === "unprivilegedReachable" || key === "recoverableUnder1hr" || key === "inScope")) {
        out[key] = trimmed === "true";
        continue;
      }
      if (
        (key === "startLine" || key === "endLine") &&
        /^\d+$/u.test(value.trim()) &&
        Number.parseInt(value.trim(), 10) > 0
      ) {
        out[key] = Number.parseInt(value.trim(), 10);
        continue;
      }
    }
    if (Array.isArray(value)) {
      out[key] = value.map(coerceScalarDrift);
      continue;
    }
    if (value !== null && typeof value === "object") {
      out[key] = coerceScalarDrift(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

const evidenceEntrySchema = z.object({
  path: z.string().catch("(unanchored)"),
  startLine: z.number().int().positive().nullable().catch(null),
  endLine: z.number().int().positive().nullable().catch(null),
  symbol: z.string().nullable().catch(null),
  quote: z.string().nullable().catch(null),
});

export const auditFindingSchema = z.object({
  title: z.string(),
  category: z.string().catch("security"),
  severity: z.enum(severities).catch("medium"),
  confidence: z.enum(["high", "medium", "low"]).catch("medium"),
  evidence: z.array(evidenceEntrySchema).catch([]),
  reasoning: z.string().catch(""),
  // Advisory metadata only (see module header). Never gates promotion.
  triggerRole: z.string().catch("unspecified"),
  preconditions: z.string().catch("unspecified"),
  unprivilegedReachable: z.boolean().optional().default(false),
  recoverableUnder1hr: z.boolean().optional().default(false),
  inScope: z.boolean().optional().default(false),
  duplicateOf: z.string().nullable().optional().default(null),
});

export type AuditFinding = z.infer<typeof auditFindingSchema>;
export type AuditEvidence = AuditFinding["evidence"][number];

export type RejectedFindingRecord = {
  index: number;
  reason: string;
  /** The untouched original element, preserved for operator inspection. */
  raw: unknown;
};

export type LenientParseResult = {
  findings: AuditFinding[];
  /** Findings that could not be parsed even after coercion — kept RAW, never discarded. */
  rejectedRaw: RejectedFindingRecord[];
};

function salvagePlaceholder(title: string, reason: string): AuditFinding {
  return auditFindingSchema.parse({
    title,
    severity: "low",
    confidence: "low",
    evidence: [],
    reasoning: reason,
    unprivilegedReachable: false,
  });
}

const PLACEHOLDER_TITLE = "(unparseable finding)";

/**
 * Lenient parse of the findings array: try each element directly, then after
 * scalar-drift coercion, then salvage a VISIBLE placeholder. Raw rejected
 * elements are returned alongside — never silently dropped (live-e2e lesson:
 * whole-array `.catch([])` once turned a 6.6k-token response into zero
 * findings).
 */
export function lenientParseFindings(rawFindings: readonly unknown[]): LenientParseResult {
  const findings: AuditFinding[] = [];
  const rejectedRaw: RejectedFindingRecord[] = [];
  rawFindings.forEach((element, index) => {
    const direct = auditFindingSchema.safeParse(element);
    if (direct.success) {
      findings.push(direct.data);
      return;
    }
    const coerced = auditFindingSchema.safeParse(coerceScalarDrift(element));
    if (coerced.success) {
      findings.push(coerced.data);
      return;
    }
    const title =
      typeof element === "object" && element !== null && typeof (element as { title?: unknown }).title === "string"
        ? (element as { title: string }).title
        : PLACEHOLDER_TITLE;
    findings.push(salvagePlaceholder(title, `finding failed lenient parse (${direct.error.issues[0]?.message ?? "unknown"}); inspect raw in report`));
    rejectedRaw.push({ index, reason: direct.error.message, raw: element });
  });
  return { findings, rejectedRaw };
}

// Structured whole-output schema for callers that want a single zod object
// (run.ts uses lenientParseFindings directly for per-finding granularity).
export const auditOutputSchema = z.object({
  findings: z.array(auditFindingSchema),
  inspected: z
    .object({ files: z.array(z.string()).default([]), notes: z.array(z.string()).default([]) })
    .catch({ files: [], notes: [] }),
});
