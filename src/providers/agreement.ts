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

// Safe because findingsAgree gates category exact + severity ±1 BEFORE evidence
// overlap, so slack only merges already-agreeing findings on the same file.
const LINE_OVERLAP_SLACK = 5;

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
  return evidenceOverlaps(a.evidence, b.evidence);
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

function evidenceOverlaps(a: Finding["evidence"], b: Finding["evidence"]): boolean {
  for (const ea of a) {
    for (const eb of b) {
      if (normalizePath(ea.path) !== normalizePath(eb.path)) {
        continue;
      }
      if (evidenceEntriesOverlap(ea, eb)) {
        return true;
      }
    }
  }
  return false;
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//u, "").replace(/\\/gu, "/");
}

function lineRangesOverlap(
  aStart: number | null,
  aEnd: number | null,
  bStart: number | null,
  bEnd: number | null,
): boolean {
  if ((aStart === null && aEnd === null) || (bStart === null && bEnd === null)) return false;
  const aS = aStart ?? aEnd ?? 0;
  const aE = aEnd ?? aStart ?? 0;
  const bS = bStart ?? bEnd ?? 0;
  const bE = bEnd ?? bStart ?? 0;
  return aS <= bE + LINE_OVERLAP_SLACK && bS <= aE + LINE_OVERLAP_SLACK;
}

function evidenceEntriesOverlap(
  a: Finding["evidence"][number],
  b: Finding["evidence"][number],
): boolean {
  if (lineRangesOverlap(a.startLine, a.endLine, b.startLine, b.endLine)) return true;
  if (a.symbol !== null && b.symbol !== null && a.symbol === b.symbol) return true;
  if (a.quote !== null && b.quote !== null && a.quote === b.quote) return true;
  // Sparse-evidence fallback: GPT-5 (and other OpenAI reasoning models) sometimes
  // emit findings with only a file path — startLine/endLine/symbol/quote all null —
  // because the structured-output schema allows nullability and the model isn't
  // confident about the position. Without this fallback, a unanimous-mode review
  // pairing a fully-localized Anthropic finding with a path-only GPT-5 finding on
  // the same file returns no consensus, even when both clearly identify the same
  // bug (observed in bench-claude-mem PR #1, mergeSettings data-loss finding).
  //
  // The caller (`evidenceOverlaps`) already confirmed path equality before we
  // get here, and `findingsAgree` already required category + severity proximity.
  // Treating a fully-sparse evidence entry as a path-level wildcard is bounded by
  // those upstream gates. A single sparse finding may cluster with multiple
  // non-sparse findings in the same file under the same category, which is the
  // correct behavior — we'd rather over-cluster than silently drop consensus.
  if (isPathOnly(a) || isPathOnly(b)) return true;
  return false;
}

function isPathOnly(e: Finding["evidence"][number]): boolean {
  return e.startLine === null && e.endLine === null && e.symbol === null && e.quote === null;
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
