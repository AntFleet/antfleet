import { getInstallationOctokit } from "./github-app";
import type { Finding } from "./review-types";

// Order matches AGENTS.md §15 framing — direct, technical. Highest-priority
// items first so reviewers see them before scrolling.
const SEVERITY_ORDER: readonly Finding["severity"][] = [
  "critical",
  "high",
  "medium",
  "low",
];

const REASONING_MAX_CHARS = 500;
const RECOMMENDATION_MAX_CHARS = 300;

export type ReviewMeta = {
  reviewId: string;
  totalMs: number;
  estimatedCostUsd: number;
  modelIds: Record<string, string>;
};

export function formatPRComment(findings: Finding[], meta: ReviewMeta): string {
  if (findings.length === 0) return "";
  const sorted = [...findings].sort((a, b) => severityRank(a) - severityRank(b));
  const intro =
    `## AntFleet · ${findings.length} finding${findings.length === 1 ? "" : "s"}\n\n` +
    "Both reviewers flagged the items below on the changed files. AntFleet posts only what two independent frontier models agree on.";
  const body = sorted.map(formatFinding).join("\n\n---\n\n");
  const stack = Object.values(meta.modelIds)
    .map((m) => `\`${m}\``)
    .join(" + ");
  const footer =
    `<sub>Review \`${meta.reviewId.slice(0, 8)}\` · ${stack} (unanimous) ` +
    `· ${Math.round(meta.totalMs / 1000)}s · ~$${meta.estimatedCostUsd.toFixed(2)}</sub>`;
  return `${intro}\n\n---\n\n${body}\n\n—\n\n${footer}`;
}

function formatFinding(f: Finding): string {
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
