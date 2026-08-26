// Scoring pipeline for the whole-contract Solidity sidecar — POST-AUDIT REWORK.
// specs/SOLIDITY_SIDECAR_SPEC.md §3-C as reworked by REWORK_PROMPT.md:
//
// The old self-graded 4-factor AND (model booleans → PURSUE) was removed as the
// promotion gate: it let the finding-inventing model hand itself the answer key.
// Promotion to PURSUE now requires BOTH:
//   1. Mechanical citation-grounding (this module, no model involved) — every
//      evidence path/line/quote resolves against the real closure; and
//   2. SURVIVED verdict from an independent adversarial refuter pass
//      (refuter.ts — a separate call whose only job is to KILL the finding).
// Model-emitted booleans remain advisory metadata rendered in reports.

import type { AuditFinding } from "./finding-schema.js";
import { SEVERITY_RANK, type Severity } from "./finding-schema.js";

export type Verdict = "PURSUE" | "DROP";

/** Advisory summary of the model's self-reported factors. Never gates promotion. */
export function advisorySummary(finding: AuditFinding): string {
  const parts: string[] = [];
  if (!finding.unprivilegedReachable) {
    parts.push("model claims privileged-gated");
  }
  if (finding.recoverableUnder1hr) {
    parts.push("model claims recoverable within damage cap");
  }
  if (!finding.inScope) {
    parts.push("model claims out of scope");
  }
  if (finding.duplicateOf !== null) {
    parts.push(`model flags possible duplicate: ${finding.duplicateOf}`);
  }
  return parts.length === 0 ? "no adverse advisory factors" : parts.join("; ");
}

// --- Mechanical citation-grounding (item 2, no model involved) ---------------

export type GroundedFile = {
  /** Repo-relative path exactly as assembled into the closure context. */
  path: string;
  contents: string;
};

export type GroundingResult = { ok: true } | { ok: false; reason: string };

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Deterministic, free citation check. A finding whose citation does not resolve
 * is auto-DROPped with `evidence not locatable in closure`:
 *  - every evidence path must be a file in the closure (exact or unique-suffix);
 *  - every line range must fall within that file's REAL bounds;
 *  - a present quote must match the cited span (whitespace-normalized).
 */
export function groundFinding(
  finding: AuditFinding,
  closureFiles: readonly GroundedFile[],
): GroundingResult {
  if (finding.evidence.length === 0) {
    return { ok: false, reason: "evidence not locatable in closure (no evidence entries)" };
  }
  for (const evidence of finding.evidence) {
    const file = resolveClosureFile(evidence.path, closureFiles);
    if (file === undefined) {
      return {
        ok: false,
        reason: `evidence not locatable in closure (path "${evidence.path}" is not in the assembled closure)`,
      };
    }
    const lineCount = countLines(file.contents);
    const start = evidence.startLine;
    const end = evidence.endLine ?? start;
    if (start === null || end === null) {
      // Path-only citations are unverifiable positions — require lines too.
      return {
        ok: false,
        reason: `evidence not locatable in closure ("${evidence.path}" cited without line numbers)`,
      };
    }
    if (start < 1 || start > lineCount || end < start || end > lineCount) {
      return {
        ok: false,
        reason: `evidence not locatable in closure (${evidence.path}:${start}-${end} outside real bounds 1-${lineCount})`,
      };
    }
    if (evidence.quote !== null && evidence.quote.trim().length > 0) {
      const span = normalizeWhitespace(extractSpan(file.contents, start, end));
      const quoted = normalizeWhitespace(evidence.quote);
      if (!span.includes(quoted)) {
        return {
          ok: false,
          reason: `evidence not locatable in closure (quote does not match ${evidence.path}:${start}-${end})`,
        };
      }
    }
  }
  return { ok: true };
}

function extractSpan(contents: string, startLine: number, endLine: number): string {
  const lines = contents.split(/\r?\n/u);
  return lines.slice(startLine - 1, endLine).join("\n");
}

function countLines(contents: string): number {
  return contents.split(/\r?\n/u).length;
}

function resolveClosureFile(
  citedPath: string,
  files: readonly GroundedFile[],
): GroundedFile | undefined {
  const exact = files.find((f) => f.path === citedPath || f.path.endsWith(`/${citedPath}`));
  if (exact !== undefined) {
    return exact;
  }
  // Cited paths sometimes carry repo prefixes; match on unique basename+dir tail.
  const suffixMatches = files.filter((f) => citedPath.endsWith(f.path));
  return suffixMatches.length === 1 ? suffixMatches[0] : undefined;
}

// --- Promotion (refuter + grounding compose here) ----------------------------

export type RefuterVerdict = "KILLED" | "SURVIVED";

export type RefutationResult = {
  verdict: RefuterVerdict;
  reason: string;
};

export type PromotionInput = {
  grounding: GroundingResult;
  refutation: RefutationResult | null; // null = refuter pass did not run (dry-run)
};

export type PromotionDecision = {
  verdict: Verdict;
  reason: string;
};

/**
 * THE promotion gate. A finding is PURSUE iff its citations ground mechanically
 * AND an independent refuter failed to kill it. Anything else drops WITH its
 * reason. With refutation === null (dry-run), findings cap at PENDING-GRADE
 * "DROP" with reason `awaiting refuter` — dry-run never promotes.
 */
export function promote(input: PromotionInput): PromotionDecision {
  if (!input.grounding.ok) {
    return { verdict: "DROP", reason: input.grounding.reason };
  }
  if (input.refutation === null) {
    return { verdict: "DROP", reason: "grounded but awaiting independent refuter pass (dry-run)" };
  }
  if (input.refutation.verdict === "KILLED") {
    return { verdict: "DROP", reason: `killed by independent refuter: ${input.refutation.reason}` };
  }
  return { verdict: "PURSUE", reason: "survived independent refuter + citation grounded" };
}

/** Highest severity among findings matching a labeled bug (kill-gate helper kept near scoring). */
export function maxSeverity(severitiesSeen: readonly Severity[]): Severity | null {
  let best: Severity | null = null;
  for (const s of severitiesSeen) {
    if (best === null || SEVERITY_RANK[s] > SEVERITY_RANK[best]) {
      best = s;
    }
  }
  return best;
}
