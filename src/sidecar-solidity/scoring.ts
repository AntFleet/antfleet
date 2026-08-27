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
 * is auto-DROPped with `evidence not locatable in closure`. Two regimes:
 *
 *  - **Quote present (the strong signal):** the quote is authoritative. LLMs
 *    quote real source accurately but miscount line numbers badly (measured in
 *    e2e: correct code cited at the wrong lines → 100% false-DROP under a
 *    span-exact check). So a present quote is located ANYWHERE in the cited file
 *    (whitespace-normalized). If found, the citation is grounded and its line
 *    numbers are RE-ANCHORED to the quote's true position (report accuracy). A
 *    quote that appears nowhere in the file is fabricated → DROP. Whether the
 *    quoted code actually supports the claim is the refuter's job, not grounding's.
 *  - **Quote absent (weak fallback):** all we can verify is that the cited line
 *    range falls within the file's real bounds. A bare path or out-of-bounds
 *    range → DROP.
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
    const hasQuote = evidence.quote !== null && evidence.quote.trim().length > 0;
    if (hasQuote) {
      const anchor = locateQuote(file.contents, evidence.quote as string);
      if (anchor === null) {
        return {
          ok: false,
          reason: `evidence not locatable in closure (quote does not match anything in ${evidence.path})`,
        };
      }
      // Re-anchor to where the quote really is — the model's own line numbers are
      // unreliable and the report must cite the true location.
      evidence.startLine = anchor.startLine;
      evidence.endLine = anchor.endLine;
      continue;
    }
    const lineCount = countLines(file.contents);
    const start = evidence.startLine;
    const end = evidence.endLine ?? start;
    if (start === null || end === null) {
      // Path-only citations are unverifiable positions — require lines too.
      return {
        ok: false,
        reason: `evidence not locatable in closure ("${evidence.path}" cited without line numbers or a quote)`,
      };
    }
    if (start < 1 || start > lineCount || end < start || end > lineCount) {
      return {
        ok: false,
        reason: `evidence not locatable in closure (${evidence.path}:${start}-${end} outside real bounds 1-${lineCount})`,
      };
    }
  }
  return { ok: true };
}

/**
 * Find a (possibly multi-line) quote in the file, tolerating whitespace
 * differences and the model quoting a substring of each line. Returns the 1-based
 * line span of the match, or null when the quote is nowhere in the file.
 */
function locateQuote(
  contents: string,
  quote: string,
): { startLine: number; endLine: number } | null {
  const fileLines = contents.split(/\r?\n/u);
  const normFile = fileLines.map(normalizeWhitespace);
  // ELISION-AWARE PATH (e2e regression): the finder routinely renders evidence
  // as `signature { frag ... frag }` — one quote string with literal `...`
  // marking omitted code. `...` never appears in real Solidity source, so treat
  // it as a fragment separator and require every SUBSTANTIAL fragment to occur,
  // in order, in the file. Measured live on Puffer VaultV5: this style
  // false-DROPped 3/3 findings whose fragments were all verbatim-present.
  if (quote.includes("...")) {
    const elided = locateElidedQuote(normFile, quote);
    if (elided !== null) {
      return elided;
    }
    // Fall through: the `...` may have been incidental, try the normal matchers.
  }
  const quoteLines = quote
    .split(/\r?\n/u)
    .map(normalizeWhitespace)
    .filter((l) => l.length > 0);
  if (quoteLines.length === 0) {
    return null;
  }
  // Consecutive line-by-line match: each file line must contain the corresponding
  // quote line (handles leading-indent and trailing-comment differences).
  for (let i = 0; i <= normFile.length - quoteLines.length; i++) {
    let matched = true;
    for (let j = 0; j < quoteLines.length; j++) {
      const fileLine = normFile[i + j];
      if (fileLine === undefined || !fileLine.includes(quoteLines[j] as string)) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { startLine: i + 1, endLine: i + quoteLines.length };
    }
  }
  // Fallback: the whole quote appears as one normalized run (model reflowed the
  // line breaks). Anchor on the first quote line.
  if (normFile.join(" ").includes(quoteLines.join(" "))) {
    const first = quoteLines[0] as string;
    const idx = normFile.findIndex((l) => l.includes(first));
    if (idx >= 0) {
      return { startLine: idx + 1, endLine: Math.min(idx + quoteLines.length, fileLines.length) };
    }
  }
  // Last resort: models routinely alter ONE line of a long multi-line quote
  // (reflow, an added comment, a paraphrased body line), which breaks a whole-
  // block match even though the citation is real. Anchor on the most distinctive
  // single quote line that actually occurs in the file — one substantial real
  // line is strong evidence the citation points at real code; whether the code
  // supports the claim is the refuter's job, not grounding's. A quote with NO
  // substantial line in the file is still fabrication → null.
  const distinctive = quoteLines
    .filter((l) => l.length >= 12)
    .toSorted((a, b) => b.length - a.length);
  for (const line of distinctive) {
    const idx = normFile.findIndex((l) => l.includes(line));
    if (idx >= 0) {
      return { startLine: idx + 1, endLine: Math.min(idx + quoteLines.length, fileLines.length) };
    }
  }
  return null;
}

/**
 * Match an elided quote (`frag ... frag ... frag`) against the file. Splits on
 * `...`, keeps the substantial fragments, and requires them to appear IN ORDER
 * as whitespace-normalized substrings of the file. Matching is done against the
 * space-JOINED file (not per-line) because a single fragment routinely spans
 * consecutive source lines — the model joins `sig {` and the next body line with
 * a space, reserving `...` for the omitted middle. Anchors the reported span to
 * the first..last matched fragment. Fabrication defense holds: any substantial
 * fragment missing (or out of order) → null (DROP). A grab-bag of only-tiny
 * fragments (none ≥12 chars) is too weak to anchor → null.
 */
function locateElidedQuote(
  normFile: readonly string[],
  quote: string,
): { startLine: number; endLine: number } | null {
  const fragments = quote
    .split(/\.\.\.+/u)
    .map(normalizeWhitespace)
    .filter((f) => f.length >= 8);
  if (fragments.length === 0 || !fragments.some((f) => f.length >= 12)) {
    return null;
  }
  // Join the normalized file into one string, tracking each line's start offset
  // so a char-index match can be mapped back to a 1-based line number.
  const lineStart: number[] = [];
  let offset = 0;
  for (const line of normFile) {
    lineStart.push(offset);
    offset += line.length + 1; // +1 for the join separator
  }
  const joined = normFile.join(" ");
  const lineOf = (charIdx: number): number => {
    let lo = 0;
    let hi = lineStart.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((lineStart[mid] as number) <= charIdx) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  };
  let searchFrom = 0;
  let firstIdx = -1;
  let lastEndIdx = -1;
  for (const frag of fragments) {
    const idx = joined.indexOf(frag, searchFrom);
    if (idx < 0) {
      return null; // a substantial fragment is missing / out of order → not grounded
    }
    if (firstIdx < 0) {
      firstIdx = idx;
    }
    lastEndIdx = idx + frag.length;
    searchFrom = idx + frag.length; // in-order, non-overlapping
  }
  return { startLine: lineOf(firstIdx) + 1, endLine: lineOf(lastEndIdx - 1) + 1 };
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
