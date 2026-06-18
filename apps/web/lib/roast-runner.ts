// Roast runner (D6). Drives a queued roast_submissions row through
// running → published | rejected by fetching a sample of source files
// from the target repo and calling reviewPR() with prNumber=0
// (synthetic). Findings land in agent_findings under the conventional
// agent_token_address "roast:<submissionId>"; the result page at
// /roasts/[id] reads them under that key.
//
// One publish per 24h. The cron at /api/cron/roast invokes this every
// 30m, but most ticks are no-ops once a roast for the day has shipped.

import { Octokit } from "@octokit/rest";
import { reviewPR } from "./review-pipeline";
import { writeRoastPostDraft } from "./post-drafts";
import { logError, logInfo, logWarn, messageOf } from "./log";
import type { Finding } from "./review-types";
import type { NewAgentFinding, RoastSubmission } from "@/db/schema";
import {
  claimRoastForRunning,
  countRoastsPublishedSince,
  insertRoastFindings,
  markRoastPublished,
  markRoastRejected,
  selectOldestQueuedRoast,
} from "@/db/queries";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FILES = 20;
const MAX_BYTES_PER_FILE = 50_000;
const MAX_TOTAL_BYTES = 500_000;

// File-type allowlist for the sampler. Source code only — skip lockfiles,
// assets, generated artefacts. README and a few manifest files always go
// in first so the reviewer has project context.
const ALWAYS_INCLUDE = new Set([
  "README.md",
  "README.mdx",
  "README",
  "README.txt",
  "package.json",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "foundry.toml",
  "hardhat.config.ts",
  "hardhat.config.js",
]);

const SOURCE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".sol",
  ".swift",
  ".kt",
  ".java",
  ".cs",
  ".rb",
  ".php",
  ".lua",
  ".ex",
  ".cpp",
  ".cc",
  ".c",
  ".h",
  ".hpp",
]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  "vendor",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
  "out",
  ".pnpm-store",
  "coverage",
  // Foundry writes per-chain deployment receipts here (run-latest.json,
  // run-<ts>.json) — transaction hashes, gas reports, broadcast logs.
  // Auditor noise when treated as source under review.
  "broadcast",
]);

export type RoastRunResult =
  | { status: "skipped-rate"; reason: "already-published-in-24h" }
  | { status: "skipped-empty"; reason: "no-queued" }
  | { status: "skipped-race"; reason: "lost-claim"; submissionId: string }
  | { status: "published"; submissionId: string; findingsCount: number; receiptId: string }
  | { status: "rejected"; submissionId: string; reason: string };

export type RoastRunnerDeps = {
  // Inject for tests; defaults pull from real env / DB / GitHub.
  createOctokit: () => Octokit;
  reviewPR: typeof reviewPR;
  selectOldestQueued: typeof selectOldestQueuedRoast;
  claimForRunning: typeof claimRoastForRunning;
  markPublished: typeof markRoastPublished;
  markRejected: typeof markRoastRejected;
  countPublishedSince: typeof countRoastsPublishedSince;
  insertFindings: typeof insertRoastFindings;
  writeDraft: typeof writeRoastPostDraft;
  now: () => Date;
};

export function realRunnerDeps(): RoastRunnerDeps {
  return {
    createOctokit: () =>
      new Octokit({
        auth: process.env["ROAST_GH_TOKEN"] ?? undefined,
        userAgent: "antfleet-roast-runner",
      }),
    reviewPR,
    selectOldestQueued: selectOldestQueuedRoast,
    claimForRunning: claimRoastForRunning,
    markPublished: markRoastPublished,
    markRejected: markRoastRejected,
    countPublishedSince: countRoastsPublishedSince,
    insertFindings: insertRoastFindings,
    writeDraft: writeRoastPostDraft,
    now: () => new Date(),
  };
}

export async function runOneRoast(
  deps: RoastRunnerDeps = realRunnerDeps(),
): Promise<RoastRunResult> {
  const since24h = new Date(deps.now().getTime() - DAY_MS);
  const publishedCount = await deps.countPublishedSince(since24h);
  if (publishedCount > 0) {
    return { status: "skipped-rate", reason: "already-published-in-24h" };
  }

  const submission = await deps.selectOldestQueued();
  if (submission === null) {
    return { status: "skipped-empty", reason: "no-queued" };
  }

  const claimed = await deps.claimForRunning(submission.id);
  if (!claimed) {
    logInfo("roast_runner.lost_claim", { submissionId: submission.id });
    return { status: "skipped-race", reason: "lost-claim", submissionId: submission.id };
  }

  logInfo("roast_runner.start", {
    submissionId: submission.id,
    repoFullName: submission.repoFullName,
  });

  try {
    const findings = await reviewRepo(submission, deps);
    if (findings.length === 0) {
      throw new Error("reviewer returned zero agreed findings");
    }

    const findingRows = buildFindingRows(submission, findings);
    await deps.insertFindings(findingRows);

    const receiptId = `roast-${submission.id}`;
    await deps.markPublished(submission.id, receiptId);

    const topFinding = pickTopFinding(findings);
    await deps.writeDraft({
      submissionId: submission.id,
      repoFullName: submission.repoFullName,
      pageUrl: `https://www.antfleet.dev/roasts/${submission.id}`,
      findingsCount: findings.length,
      topSeverity: topFinding !== null ? mapSeverity(topFinding.severity) : null,
      topFindingTitle: topFinding?.title ?? null,
      submitterHandle: submission.submitterHandle,
    });

    logInfo("roast_runner.published", {
      submissionId: submission.id,
      findingsCount: findings.length,
      receiptId,
    });
    return {
      status: "published",
      submissionId: submission.id,
      findingsCount: findings.length,
      receiptId,
    };
  } catch (err) {
    const reason = messageOf(err);
    logError("roast_runner.failed", { submissionId: submission.id, reason });
    await deps.markRejected(submission.id, reason).catch((markErr) => {
      logError("roast_runner.mark_rejected_failed", {
        submissionId: submission.id,
        reason: messageOf(markErr),
      });
    });
    return { status: "rejected", submissionId: submission.id, reason };
  }
}

async function reviewRepo(submission: RoastSubmission, deps: RoastRunnerDeps): Promise<Finding[]> {
  const [owner, repo] = submission.repoFullName.split("/");
  if (owner === undefined || repo === undefined) {
    throw new Error(`invalid repo_full_name: ${submission.repoFullName}`);
  }
  const octokit = deps.createOctokit();

  const repoInfo = await octokit.rest.repos.get({ owner, repo });
  const defaultBranch = repoInfo.data.default_branch ?? "main";

  const tree = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: defaultBranch,
    recursive: "true",
  });

  const files = pickFiles(tree.data.tree ?? []);
  if (files.length === 0) {
    throw new Error("no source files found at the repo root");
  }

  // ChangedFile is shaped for PR diffs (status+sha+patch); we're sampling the
  // default branch so status is synthetic and there's no PR diff. The reviewer
  // prompt uses only filename + contents. Patch is null because roasts are
  // file-snapshot reviews, not diff reviews — the Patch Agent lane skips
  // roast findings since they have no hunks to anchor a suggestion against.
  const fetched: Array<{
    filename: string;
    contents: string;
    status: "added";
    sha: string;
    patch: null;
  }> = [];
  let totalBytes = 0;
  for (const filePath of files) {
    if (totalBytes >= MAX_TOTAL_BYTES) break;
    const contents = await fetchFileContents(octokit, owner, repo, filePath);
    if (contents === null) continue;
    const trimmed =
      contents.length > MAX_BYTES_PER_FILE
        ? `${contents.slice(0, MAX_BYTES_PER_FILE)}\n[TRUNCATED: showing first ${MAX_BYTES_PER_FILE} of ${contents.length} bytes]`
        : contents;
    fetched.push({
      filename: filePath,
      contents: trimmed,
      status: "added",
      sha: "HEAD",
      patch: null,
    });
    totalBytes += trimmed.length;
  }

  if (fetched.length === 0) {
    throw new Error("could not fetch any source files");
  }

  logInfo("roast_runner.fetched", {
    submissionId: submission.id,
    fileCount: fetched.length,
    totalBytes,
  });

  const bundle = await deps.reviewPR({
    files: fetched,
    owner,
    repo,
    prNumber: 0,
  });

  if (bundle.degraded) {
    throw new Error(`review degraded: ${bundle.degradedReason ?? "unknown"}`);
  }

  return bundle.agreed;
}

type TreeNode = { path?: string; type?: string; size?: number };

function pickFiles(tree: TreeNode[]): string[] {
  const picks: string[] = [];
  const alwaysHit: string[] = [];
  const sourceCandidates: string[] = [];

  for (const node of tree) {
    if (node.type !== "blob" || typeof node.path !== "string") continue;
    const parts = node.path.split("/");
    if (parts.some((p) => SKIP_DIRS.has(p))) continue;
    const base = parts[parts.length - 1] ?? "";
    if (ALWAYS_INCLUDE.has(base)) {
      alwaysHit.push(node.path);
      continue;
    }
    const dotIdx = base.lastIndexOf(".");
    if (dotIdx <= 0) continue;
    const ext = base.slice(dotIdx);
    if (!SOURCE_EXTS.has(ext)) continue;
    sourceCandidates.push(node.path);
  }

  // Prefer shallower paths — typically the most architecturally significant.
  sourceCandidates.sort((a, b) => {
    const ad = a.split("/").length;
    const bd = b.split("/").length;
    if (ad !== bd) return ad - bd;
    return a.localeCompare(b);
  });

  picks.push(...alwaysHit);
  for (const p of sourceCandidates) {
    if (picks.length >= MAX_FILES) break;
    picks.push(p);
  }
  return picks;
}

async function fetchFileContents(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
): Promise<string | null> {
  try {
    const response = await octokit.rest.repos.getContent({ owner, repo, path });
    const data = response.data;
    if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") {
      return null;
    }
    if (data.encoding !== "base64") return null;
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (err) {
    logWarn("roast_runner.fetch_file_failed", { path, reason: messageOf(err) });
    return null;
  }
}

function buildFindingRows(submission: RoastSubmission, findings: Finding[]): NewAgentFinding[] {
  return findings.map((f, idx) => {
    const findingId = `roast-${submission.id}-${idx + 1}`;
    return {
      findingId,
      agentTokenAddress: `roast:${submission.id}`,
      agentName: `roast-${submission.repoFullName.replace(/\//g, "-")}`,
      repoFullName: submission.repoFullName,
      title: f.title,
      severity: mapSeverity(f.severity),
      summary: composeSummary(f),
      evidence: composeEvidence(f),
      upstreamPrUrl: null,
      upstreamMergedSha: null,
    };
  });
}

// Reviewer outputs critical/high/medium/low; agent_findings convention is
// info/low/med/high. Collapse critical→high and shorten medium→med.
function mapSeverity(s: Finding["severity"]): string {
  if (s === "critical") return "high";
  if (s === "high") return "high";
  if (s === "medium") return "med";
  return "low";
}

function composeSummary(f: Finding): string {
  return `${f.reasoning}\n\n**Recommendation:** ${f.recommendation}`;
}

function composeEvidence(f: Finding): string | null {
  const parts: string[] = [];
  if (f.evidence.length > 0) {
    const evidenceLines = f.evidence.map((e) => {
      const symbol = e.symbol ?? "";
      const quote = e.quote ?? "";
      const where = symbol.length > 0 ? `${e.path}:${symbol}` : e.path;
      return quote.length > 0 ? `- \`${where}\` — ${quote}` : `- \`${where}\``;
    });
    parts.push(evidenceLines.join("\n"));
  }
  if (typeof f.reproduction === "string" && f.reproduction.length > 0) {
    parts.push(`**Reproduction:** ${f.reproduction}`);
  }
  if (typeof f.suggestedRegressionTest === "string" && f.suggestedRegressionTest.length > 0) {
    parts.push(`**Suggested regression test:** ${f.suggestedRegressionTest}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function pickTopFinding(findings: Finding[]): Finding | null {
  const rank: Record<Finding["severity"], number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };
  let best: Finding | null = null;
  let bestRank = -1;
  for (const f of findings) {
    const r = rank[f.severity] ?? 0;
    if (r > bestRank) {
      best = f;
      bestRank = r;
    }
  }
  return best;
}
