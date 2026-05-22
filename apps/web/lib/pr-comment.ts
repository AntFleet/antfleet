import { getInstallationOctokit } from "./github-app";
import type { Finding } from "./review-types";

// Order matches AGENTS.md §15 framing — direct, technical. Highest-priority
// items first so reviewers see them before scrolling.
const SEVERITY_ORDER: readonly Finding["severity"][] = ["critical", "high", "medium", "low"];

const REASONING_MAX_CHARS = 500;
const RECOMMENDATION_MAX_CHARS = 300;

// Patch Agent v1.5 — per-finding patch decision the renderer can embed.
// Patch is the unified-diff text the gate selected; modelId names the
// provider whose patch shipped (always claude-opus-4-7 in v1). When null
// (or absent from the patches map), formatFinding emits no suggestion block.
export type PatchForRender = {
  patch: string;
  modelId: string;
};

export type ReviewMeta = {
  reviewId: string;
  totalMs: number;
  estimatedCostUsd: number;
  modelIds: Record<string, string>;
  // Paywall settlement footer. Present when the review was paid for via
  // an agent paywall channel; absent for legacy_partner reviews and for
  // pre-paywall reviews. lastDepositTxHash links to basescan as proof of
  // funding; channelBalanceUsdc is the post-debit balance.
  settlement?: {
    channelBalanceUsdc: string;
    lastDepositTxHash: string | null;
  };
  // Patch Agent v1.5 — optional per-finding patches. Keyed by the finding's
  // position in the agreed[] array as passed to formatPRComment (NOT the
  // post-sort severity order, since this layer never sees DB findingIds).
  // Missing key = no patch for that finding; emit findings-only for it.
  // Absent entirely = no patches in this review (flag off, or all findings
  // failed the gate). The comment body shape is byte-identical to v1.4
  // in that case.
  patchesByIndex?: ReadonlyMap<number, PatchForRender>;
};

export function formatPRComment(findings: Finding[], meta: ReviewMeta): string {
  if (findings.length === 0) return "";
  // Stash the input index alongside each finding so the post-sort body
  // can look up the right patch (patchesByIndex is keyed by the pre-sort
  // index — that's the DB findingIndex the worker writes).
  const indexed = findings.map((f, originalIndex) => ({ f, originalIndex }));
  const sorted = indexed.toSorted((a, b) => severityRank(a.f) - severityRank(b.f));
  const intro =
    `## AntFleet · ${findings.length} finding${findings.length === 1 ? "" : "s"}\n\n` +
    "Both reviewers flagged the items below on the changed files. AntFleet posts only what two independent frontier models agree on.";
  const body = sorted
    .map(({ f, originalIndex }) =>
      formatFinding(f, meta.patchesByIndex?.get(originalIndex) ?? null),
    )
    .join("\n\n---\n\n");
  const stack = Object.values(meta.modelIds)
    .map((m) => `\`${m}\``)
    .join(" + ");
  const footerLines: string[] = [
    `<sub>Review \`${meta.reviewId.slice(0, 8)}\` · ${stack} (unanimous) ` +
      `· ${Math.round(meta.totalMs / 1000)}s · ~$${meta.estimatedCostUsd.toFixed(2)}</sub>`,
  ];
  if (meta.settlement !== undefined) {
    footerLines.push(
      formatSettlementFooter(meta.settlement, patchesPresent(meta.patchesByIndex)),
    );
  }
  return `${intro}\n\n---\n\n${body}\n\n—\n\n${footerLines.join("\n")}`;
}

function patchesPresent(
  patches: ReadonlyMap<number, PatchForRender> | undefined,
): boolean {
  return patches !== undefined && patches.size > 0;
}

function formatSettlementFooter(
  s: NonNullable<ReviewMeta["settlement"]>,
  patchIncluded: boolean,
): string {
  const balance = `${s.channelBalanceUsdc} USDC`;
  // Patch Agent v1.5: spec §4 — append "Patch settled" verb only when at
  // least one suggestion block was shipped in this comment. Pre-v1.5
  // comments (and findings-only v1.5 comments) keep the existing
  // "Settled · ..." text byte-identical.
  const verb = patchIncluded ? "Patch settled" : "Settled";
  if (s.lastDepositTxHash === null) {
    return `<sub>${verb} · channel balance ${balance}</sub>`;
  }
  const shortHash = `${s.lastDepositTxHash.slice(0, 6)}…${s.lastDepositTxHash.slice(-4)}`;
  const basescan = `https://basescan.org/tx/${s.lastDepositTxHash}`;
  return `<sub>${verb} · tx [\`${shortHash}\`](${basescan}) · channel balance ${balance}</sub>`;
}

function formatFinding(f: Finding, patch: PatchForRender | null): string {
  const ev = f.evidence[0];
  const lines: string[] = [];
  lines.push(`**${titleCase(f.category)} · ${titleCase(f.severity)}** — ${f.title}`);
  if (ev !== undefined) {
    lines.push(`\`${formatEvidencePath(ev)}\``);
  }
  lines.push("");
  lines.push(`> ${truncate(f.reasoning, REASONING_MAX_CHARS)}`);
  lines.push("");
  lines.push(`**Fix:** ${truncate(f.recommendation, RECOMMENDATION_MAX_CHARS)}`);
  // Patch Agent v1.5: optional suggestion subsection AFTER the fix line,
  // delimited as <details> so the finding metadata stays scannable and the
  // sweeper's regex on the header line is unaffected. Spec §4 names the
  // exact shape.
  if (patch !== null) {
    lines.push("");
    lines.push(`<details>`);
    lines.push(`<summary>Proposed patch (model: ${patch.modelId})</summary>`);
    lines.push("");
    lines.push("```suggestion");
    lines.push(patch.patch);
    lines.push("```");
    lines.push(`</details>`);
  }
  return lines.join("\n");
}

function formatEvidencePath(ev: Finding["evidence"][number]): string {
  if (ev.startLine === null) return ev.path;
  if (ev.endLine === null || ev.endLine === ev.startLine) {
    return `${ev.path}:${ev.startLine}`;
  }
  return `${ev.path}:${ev.startLine}-${ev.endLine}`;
}

function severityRank(f: Finding): number {
  const idx = SEVERITY_ORDER.indexOf(f.severity);
  return idx === -1 ? SEVERITY_ORDER.length : idx;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1).trimEnd()}…`;
}

/**
 * Closure receipt formatter — Mission 3 slice 3. When Sweeper detects a
 * finding's evidence file has changed on main, it posts a follow-up
 * comment on the original PR that names the closing SHA. This is the
 * receipt artifact referenced in AGENTS.md §18.2 — public, verifiable,
 * the thing customers cannot fake.
 *
 * Voice matches formatPRComment: direct, technical, no marketing. The
 * closing SHA is the load-bearing element; everything else is context
 * that reminds readers what this finding was.
 */
export type ClosureReceiptInput = {
  findingId: string;
  closureSha: string;
  finding: Finding;
  owner: string;
  repo: string;
  originalCommentUrl: string | null;
};

export function formatClosureReceipt(args: ClosureReceiptInput): string {
  const f = args.finding;
  const shortSha = args.closureSha.slice(0, 7);
  const closingCommitUrl = `https://github.com/${args.owner}/${args.repo}/commit/${args.closureSha}`;
  const ev = f.evidence[0];

  const lines: string[] = [];
  lines.push(
    `## AntFleet · finding \`${args.findingId}\` closed in [\`${shortSha}\`](${closingCommitUrl})`,
  );
  lines.push("");
  lines.push(`**${titleCase(f.category)} · ${titleCase(f.severity)}** — ${f.title}`);
  if (ev !== undefined) {
    lines.push(`\`${formatEvidencePath(ev)}\``);
  }
  lines.push("");
  if (args.originalCommentUrl !== null && args.originalCommentUrl.length > 0) {
    lines.push(
      `<sub>Originally flagged in [the AntFleet review](${args.originalCommentUrl}). Receipt automated.</sub>`,
    );
  } else {
    lines.push("<sub>Receipt automated by AntFleet.</sub>");
  }
  return lines.join("\n");
}

export async function postPRComment(args: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
}): Promise<{ id: number; htmlUrl: string }> {
  const octokit = await getInstallationOctokit(args.installationId);
  const resp = await octokit.rest.issues.createComment({
    owner: args.owner,
    repo: args.repo,
    issue_number: args.prNumber,
    body: args.body,
  });
  return { id: resp.data.id, htmlUrl: resp.data.html_url };
}
