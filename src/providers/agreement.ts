import { assertDefined } from "../errors.js";
import type { ReviewOutput } from "../types.js";

export type Finding = ReviewOutput["findings"][number];

export type AgreementMode = "unanimous" | "majority" | "any";

export type ProviderReview = {
  providerName: string;
  output: ReviewOutput;
};

export type Disagreement = {
  providers: string[];
  finding: Finding;
  reason: string;
};

// A "weak" evidence overlap — a sparse (path-only) wildcard, or line ranges that
// are near but do NOT actually intersect (within LINE_OVERLAP_SLACK) — is only
// accepted as agreement when the two findings are also textually similar (see
// findingsSimilar). This stops one path-only or nearby finding from fabricating
// "both models agreed" against an *unrelated* localized finding on the same file
// (and from collapsing several distinct findings into one cluster), while still
// recovering recall when the two providers really are describing the same bug.
// Strong overlaps — true line intersection, same symbol, or same quote — are
// accepted unconditionally.
const LINE_OVERLAP_SLACK = 5;
const SIMILARITY_THRESHOLD = 0.5;
// Generic English function words only — no domain terms (null/data/cast/etc. are
// signal, not noise). Kept small on purpose; the guard is a distinctness check,
// not a stemmer.
const SIMILARITY_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "from",
  "into",
  "onto",
  "when",
  "then",
  "than",
  "but",
  "not",
  "are",
  "was",
  "were",
  "its",
  "has",
  "had",
  "have",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "does",
  "did",
  "use",
  "used",
  "using",
  "via",
  "per",
  "out",
  "over",
  "under",
  "between",
  "because",
  "which",
  "while",
  "they",
  "them",
  "their",
  "there",
  "here",
  "also",
  "any",
  "all",
  "one",
  "two",
  "some",
  "such",
  "only",
  "same",
  "both",
  "each",
  "more",
  "most",
]);

const severityRank: Record<Finding["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const confidenceRank: Record<Finding["confidence"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function findingsAgree(a: Finding, b: Finding): boolean {
  if (a.category !== b.category) {
    return false;
  }
  if (Math.abs(severityRank[a.severity] - severityRank[b.severity]) > 1) {
    return false;
  }
  return evidenceOverlaps(a, b);
}

export function mergeFindings(
  perProvider: ProviderReview[],
  mode: AgreementMode,
): { agreed: Finding[]; disagreements: Disagreement[] } {
  if (perProvider.length === 0) {
    return { agreed: [], disagreements: [] };
  }
  const total = perProvider.length;
  const threshold = thresholdFor(mode, total);

  type Tagged = { provider: string; finding: Finding };
  const tagged: Tagged[] = [];
  for (const pr of perProvider) {
    for (const finding of pr.output.findings) {
      tagged.push({ provider: pr.providerName, finding });
    }
  }

  const parent: number[] = tagged.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    let next = assertDefined(parent[root], "agreement union-find: invariant");
    while (next !== root) {
      root = next;
      next = assertDefined(parent[root], "agreement union-find: invariant");
    }
    let cur = i;
    while (cur !== root) {
      const p = assertDefined(parent[cur], "agreement union-find: invariant");
      parent[cur] = root;
      cur = p;
    }
    return root;
  };
  const union = (i: number, j: number): void => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) {
      parent[ri] = rj;
    }
  };

  for (const [i, ti] of tagged.entries()) {
    for (let j = i + 1; j < tagged.length; j++) {
      const tj = tagged[j];
      if (tj === undefined) {
        break;
      }
      if (ti.provider === tj.provider) {
        continue;
      }
      if (findingsAgree(ti.finding, tj.finding)) {
        union(i, j);
      }
    }
  }

  const clusters = new Map<number, Tagged[]>();
  for (const [i, t] of tagged.entries()) {
    const root = find(i);
    const existing = clusters.get(root);
    if (existing === undefined) {
      clusters.set(root, [t]);
    } else {
      existing.push(t);
    }
  }

  const agreed: Finding[] = [];
  const disagreements: Disagreement[] = [];
  for (const cluster of clusters.values()) {
    const providers = uniqueSorted(cluster.map((t) => t.provider));
    const qualifyingFindings = cluster
      .filter((candidate) => directSupportProviders(candidate, cluster).length >= threshold)
      .map((candidate) => candidate.finding);
    if (qualifyingFindings.length > 0) {
      agreed.push(pickRepresentative(qualifyingFindings));
    } else {
      const representative = pickRepresentative(cluster.map((t) => t.finding));
      disagreements.push({
        providers,
        finding: representative,
        reason: `only ${providers.length} of ${total} providers (${providers.join(", ")}) flagged this; ${mode} mode requires ${threshold}`,
      });
    }
  }

  return { agreed, disagreements };
}

function directSupportProviders(
  candidate: { provider: string; finding: Finding },
  cluster: Array<{ provider: string; finding: Finding }>,
): string[] {
  const providers = new Set<string>([candidate.provider]);
  for (const tagged of cluster) {
    if (tagged.provider === candidate.provider) continue;
    if (findingsAgree(candidate.finding, tagged.finding)) {
      providers.add(tagged.provider);
    }
  }
  return Array.from(providers).toSorted();
}

function thresholdFor(mode: AgreementMode, total: number): number {
  if (mode === "unanimous") {
    return total;
  }
  if (mode === "majority") {
    return Math.floor(total / 2) + 1;
  }
  return 1;
}

type EvidenceEntry = Finding["evidence"][number];

// A strong overlap is accepted on its own. A weak overlap (sparse-path wildcard or
// near-but-not-touching line ranges) is accepted only when the two findings are
// also textually similar — see findingsSimilar / the LINE_OVERLAP_SLACK comment.
function evidenceOverlaps(a: Finding, b: Finding): boolean {
  let sawWeak = false;
  for (const ea of a.evidence) {
    for (const eb of b.evidence) {
      if (normalizePath(ea.path) !== normalizePath(eb.path)) {
        continue;
      }
      const strength = entryOverlapStrength(ea, eb);
      if (strength === "strong") {
        return true;
      }
      if (strength === "weak") {
        sawWeak = true;
      }
    }
  }
  return sawWeak ? findingsSimilar(a, b) : false;
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//u, "").replace(/\\/gu, "/");
}

function lineRangesOverlap(
  aStart: number | null,
  aEnd: number | null,
  bStart: number | null,
  bEnd: number | null,
  slack: number,
): boolean {
  if ((aStart === null && aEnd === null) || (bStart === null && bEnd === null)) return false;
  const aS = aStart ?? aEnd ?? 0;
  const aE = aEnd ?? aStart ?? 0;
  const bS = bStart ?? bEnd ?? 0;
  const bE = bEnd ?? bStart ?? 0;
  return aS <= bE + slack && bS <= aE + slack;
}

// Classifies one same-path evidence-entry pair. "strong" anchors (real line
// intersection, matching symbol, matching quote) are trusted alone. "weak"
// signals (line ranges within LINE_OVERLAP_SLACK but not intersecting, or a
// fully-sparse path-only entry) require a similarity check upstream before they
// count as agreement.
function entryOverlapStrength(a: EvidenceEntry, b: EvidenceEntry): "strong" | "weak" | "none" {
  const aHasLine = a.startLine !== null || a.endLine !== null;
  const bHasLine = b.startLine !== null || b.endLine !== null;
  // Strong anchors — accepted unconditionally. ALL strong conditions are checked
  // before any weak one, so a matching symbol/quote is never downgraded to weak
  // just because the two line ranges happen to sit within LINE_OVERLAP_SLACK.
  if (
    aHasLine &&
    bHasLine &&
    lineRangesOverlap(a.startLine, a.endLine, b.startLine, b.endLine, 0)
  ) {
    return "strong";
  }
  if (a.symbol !== null && b.symbol !== null && a.symbol === b.symbol) return "strong";
  if (a.quote !== null && b.quote !== null && a.quote === b.quote) return "strong";
  // Weak signals — corroborated by findingsSimilar upstream before they count as
  // agreement.
  if (
    aHasLine &&
    bHasLine &&
    lineRangesOverlap(a.startLine, a.endLine, b.startLine, b.endLine, LINE_OVERLAP_SLACK)
  ) {
    return "weak";
  }
  // Sparse-evidence fallback: GPT-5 (and other OpenAI reasoning models) sometimes
  // emit findings with only a file path — startLine/endLine/symbol/quote all null.
  // We still let these match a localized counterpart on the same file, but only as
  // a "weak" signal that the caller must corroborate with findingsSimilar, so a
  // path-only finding can no longer wildcard-match an unrelated localized finding
  // (or collapse several distinct findings) into a false public receipt. The
  // recall recovery it was added for — e.g. bench-claude-mem PR #1 mergeSettings —
  // survives because those genuinely-same findings clear the similarity gate.
  if (isPathOnly(a) || isPathOnly(b)) return "weak";
  return "none";
}

function isPathOnly(e: EvidenceEntry): boolean {
  return e.startLine === null && e.endLine === null && e.symbol === null && e.quote === null;
}

// Minimum number of shared meaningful tokens for a weak overlap to count as
// agreement. Without this floor, a finding that tokenizes to only two words could
// clear the overlap-coefficient on a SINGLE coincidental shared domain token
// (e.g. two unrelated findings that both say "data"), which would partially
// reintroduce the false-receipt vector this guard exists to close.
const SIMILARITY_MIN_SHARED = 2;

// Deterministic distinctness check for weak evidence overlaps: the fraction of the
// shorter finding's meaningful tokens (title + reasoning) that also appear in the
// longer one, subject to an absolute floor of SIMILARITY_MIN_SHARED shared tokens.
// Overlap-coefficient rather than Jaccard so a terse path-only finding isn't
// penalized for the counterpart's longer prose. No LLM, no network — this runs
// inside the merge path on every candidate pair.
function findingsSimilar(a: Finding, b: Finding): boolean {
  const ta = tokenize(`${a.title} ${a.reasoning}`);
  const tb = tokenize(`${b.title} ${b.reasoning}`);
  const smaller = ta.size <= tb.size ? ta : tb;
  const larger = smaller === ta ? tb : ta;
  if (smaller.size === 0) return false;
  let shared = 0;
  for (const token of smaller) {
    if (larger.has(token)) shared++;
  }
  if (shared < SIMILARITY_MIN_SHARED) return false;
  return shared / smaller.size >= SIMILARITY_THRESHOLD;
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  // Unicode letters/digits, so a non-ASCII (accented/CJK/Cyrillic) title+reasoning
  // still tokenizes instead of collapsing to the empty set and silently refusing
  // every weak overlap.
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = match[0];
    if (token.length < 3) continue;
    if (SIMILARITY_STOPWORDS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

function pickRepresentative(findings: Finding[]): Finding {
  const sorted = findings.toSorted((a, b) => {
    const sevDiff = severityRank[a.severity] - severityRank[b.severity];
    if (sevDiff !== 0) {
      return sevDiff;
    }
    return confidenceRank[a.confidence] - confidenceRank[b.confidence];
  });
  return assertDefined(sorted[0], "pickRepresentative requires a non-empty cluster");
}

function uniqueSorted(xs: string[]): string[] {
  return Array.from(new Set(xs)).toSorted();
}
