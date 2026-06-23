#!/usr/bin/env tsx
// Bench dry-run for Daybreak primitive #3: persisted repo threat models.
//
// Reads recent benchmark reviews, generates a threat model from public repo
// contents at the reviewed SHA when GitHub permits it, compares that model's
// entry points with the current changed-file-only derivation, and writes a
// markdown report under .omc/research/.
//
// No prod writes. Migration 0043 is intentionally not applied here.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import * as dotenv from "dotenv";

const selfPath = fileURLToPath(import.meta.url);
const selfDir = dirname(selfPath);
dotenv.config({ path: resolve(selfDir, "../.env.local") });

process.env["ANTFLEET_THREAT_MODEL"] = "true";

const RECENT_DAYS = 90;
const MAX_REPOS = 6;

type BenchRow = {
  reviewId: string;
  owner: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  agreementDecision: unknown;
};

type RepoReport = {
  owner: string;
  repo: string;
  reviewId: string;
  commitSha: string;
  changedEntryPoints: string[];
  repoEntryPoints: string[];
  addedEntryPoints: string[];
  removedEntryPoints: string[];
  generatedSections: {
    entryPoints: number;
    trustBoundaries: number;
    sinks: number;
    secretsSurface: number;
    criticalAssets: number;
  };
  reachabilityDecisionComparison: string;
};

async function main(): Promise<void> {
  const { db } = await import("@/db");
  const { reviews } = await import("@/db/schema");
  const { and, desc, eq, gte } = await import("drizzle-orm");
  const { hashRepo } = await import("@/db/queries");
  const { getPublicChangedFiles, makePublicOctokit, PublicRepoAccessError } =
    await import("@/lib/github-files-public");
  const { generateRepoThreatModel, getRepoThreatModelFilesWith, toReachabilityThreatModel } =
    await import("@/lib/repo-threat-model");
  const { runReachabilityGate } = await import("@/lib/reachability-gate");

  const since = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      reviewId: reviews.reviewId,
      owner: reviews.owner,
      repo: reviews.repo,
      prNumber: reviews.prNumber,
      commitSha: reviews.commitSha,
      agreementDecision: reviews.agreementDecision,
    })
    .from(reviews)
    .where(
      and(
        eq(reviews.isBenchmark, true),
        eq(reviews.publicReceipt, true),
        gte(reviews.createdAt, since),
      ),
    )
    .orderBy(desc(reviews.createdAt))
    .limit(60);

  const selected = firstPerRepo(rows)
    .filter((row): row is BenchRow => row.owner !== null && row.repo !== null)
    .slice(0, MAX_REPOS);

  const octokit = makePublicOctokit();
  const reports: RepoReport[] = [];
  for (const row of selected) {
    try {
      const changedFiles = await getPublicChangedFiles({
        owner: row.owner,
        repo: row.repo,
        prNumber: row.prNumber,
        headSha: row.commitSha,
      });
      const repoSnapshot = await getRepoThreatModelFilesWith(octokit, {
        owner: row.owner,
        repo: row.repo,
        sha: row.commitSha,
      });
      const changedModel = generateRepoThreatModel({
        owner: row.owner,
        repo: row.repo,
        repoHash: hashRepo(row.owner, row.repo),
        sha: row.commitSha,
        files: changedFiles,
      });
      const repoModel = generateRepoThreatModel({
        owner: row.owner,
        repo: row.repo,
        repoHash: hashRepo(row.owner, row.repo),
        sha: row.commitSha,
        files: repoSnapshot.files.length > 0 ? repoSnapshot.files : changedFiles,
      });
      const changedEntryPoints = entryPointKeys(toReachabilityThreatModel(changedModel));
      const reachabilityThreatModel = toReachabilityThreatModel(repoModel);
      const repoEntryPoints = entryPointKeys(reachabilityThreatModel);
      const changedSet = new Set(changedEntryPoints);
      const repoSet = new Set(repoEntryPoints);
      const comparisonFinding = firstReachabilityFinding(row.agreementDecision);
      let reachabilityDecisionComparison = "no HIGH/CRITICAL agreed finding in sampled review";
      if (comparisonFinding !== null) {
        const findingForGate = comparisonFinding as Parameters<
          typeof runReachabilityGate
        >[0]["finding"];
        const [currentOutcome, threatModelOutcome] = await Promise.all([
          runReachabilityGate({
            finding: findingForGate,
            owner: row.owner,
            repo: row.repo,
            files: changedFiles,
          }),
          runReachabilityGate({
            finding: findingForGate,
            owner: row.owner,
            repo: row.repo,
            files: changedFiles,
            threatModel: reachabilityThreatModel,
          }),
        ]);
        const changed = currentOutcome.verdict !== threatModelOutcome.verdict;
        reachabilityDecisionComparison =
          `current=${currentOutcome.verdict}; threat_model=${threatModelOutcome.verdict}; ` +
          `changed=${changed ? "yes" : "no"}`;
      }
      reports.push({
        owner: row.owner,
        repo: row.repo,
        reviewId: row.reviewId,
        commitSha: row.commitSha,
        changedEntryPoints,
        repoEntryPoints,
        addedEntryPoints: repoEntryPoints.filter((entry) => !changedSet.has(entry)),
        removedEntryPoints: changedEntryPoints.filter((entry) => !repoSet.has(entry)),
        generatedSections: {
          entryPoints: repoModel.sections.entryPoints.items.length,
          trustBoundaries: repoModel.sections.trustBoundaries.items.length,
          sinks: repoModel.sections.sinks.items.length,
          secretsSurface: repoModel.sections.secretsSurface.items.length,
          criticalAssets: repoModel.sections.criticalAssets.items.length,
        },
        reachabilityDecisionComparison,
      });
    } catch (err) {
      const message =
        err instanceof PublicRepoAccessError || err instanceof Error ? err.message : String(err);
      reports.push({
        owner: row.owner,
        repo: row.repo,
        reviewId: row.reviewId,
        commitSha: row.commitSha,
        changedEntryPoints: [],
        repoEntryPoints: [],
        addedEntryPoints: [],
        removedEntryPoints: [],
        generatedSections: {
          entryPoints: 0,
          trustBoundaries: 0,
          sinks: 0,
          secretsSurface: 0,
          criticalAssets: 0,
        },
        reachabilityDecisionComparison: `skipped: ${message}`,
      });
    }
  }

  const outPath = resolve(
    selfDir,
    "../../../.omc/research/daybreak-threat-model-bench-evidence.md",
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, renderReport(reports), "utf8");
  console.log(`wrote ${outPath}`);
}

function firstPerRepo(
  rows: Array<{
    reviewId: string;
    owner: string | null;
    repo: string | null;
    prNumber: number;
    commitSha: string;
    agreementDecision: unknown;
  }>,
): Array<{
  reviewId: string;
  owner: string | null;
  repo: string | null;
  prNumber: number;
  commitSha: string;
  agreementDecision: unknown;
}> {
  const seen = new Set<string>();
  const out: typeof rows = [];
  for (const row of rows) {
    if (row.owner === null || row.repo === null) continue;
    const key = `${row.owner.toLowerCase()}/${row.repo.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function entryPointKeys(
  model: {
    entryPoints: { items: Array<{ kind: string; path: string; line: number | null }> };
  } | null,
): string[] {
  if (model === null) return [];
  return model.entryPoints.items.map((item) => {
    const line = item.line === null ? "?" : String(item.line);
    return `${item.kind} ${item.path}:${line}`;
  });
}

function firstReachabilityFinding(value: unknown): {
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  evidence: Array<{ path: string; startLine: number | null; endLine: number | null }>;
  reasoning: string;
  recommendation: string;
  reproduction?: string | null;
} | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const agreed = (value as { agreed?: unknown }).agreed;
  if (!Array.isArray(agreed)) return null;
  for (const item of agreed) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record["severity"] !== "high" && record["severity"] !== "critical") continue;
    if (typeof record["title"] !== "string") continue;
    if (typeof record["category"] !== "string") continue;
    if (typeof record["reasoning"] !== "string") continue;
    if (typeof record["recommendation"] !== "string") continue;
    if (!Array.isArray(record["evidence"])) continue;
    const evidence = record["evidence"].filter(isEvidence);
    if (evidence.length === 0) continue;
    return {
      title: record["title"],
      severity: record["severity"],
      category: record["category"],
      evidence,
      reasoning: record["reasoning"],
      recommendation: record["recommendation"],
      reproduction:
        typeof record["reproduction"] === "string" || record["reproduction"] === null
          ? record["reproduction"]
          : null,
    };
  }
  return null;
}

function isEvidence(value: unknown): value is {
  path: string;
  startLine: number | null;
  endLine: number | null;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["path"] === "string" &&
    (typeof record["startLine"] === "number" || record["startLine"] === null) &&
    (typeof record["endLine"] === "number" || record["endLine"] === null)
  );
}

function renderReport(reports: RepoReport[]): string {
  const lines: string[] = [];
  lines.push("# Daybreak threat model bench evidence");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("Scope: recent public benchmark reviews, one latest review per repo.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(
    "| Repo | entry points | trust boundaries | sinks | secrets | assets | added vs current | removed vs current |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const report of reports) {
    lines.push(
      `| ${report.owner}/${report.repo} | ${report.generatedSections.entryPoints} | ` +
        `${report.generatedSections.trustBoundaries} | ${report.generatedSections.sinks} | ` +
        `${report.generatedSections.secretsSurface} | ${report.generatedSections.criticalAssets} | ` +
        `${report.addedEntryPoints.length} | ${report.removedEntryPoints.length} |`,
    );
  }
  lines.push("");
  lines.push("## Per repo");
  for (const report of reports) {
    lines.push("");
    lines.push(`### ${report.owner}/${report.repo}`);
    lines.push("");
    lines.push(`- review: ${report.reviewId}`);
    lines.push(`- sha: ${report.commitSha}`);
    lines.push(`- reachability decision comparison: ${report.reachabilityDecisionComparison}`);
    lines.push("- generated threat model:");
    lines.push(`  - entry points: ${inlineList(report.repoEntryPoints)}`);
    lines.push(`  - trust boundaries: ${report.generatedSections.trustBoundaries}`);
    lines.push(`  - sinks: ${report.generatedSections.sinks}`);
    lines.push(`  - secrets surface: ${report.generatedSections.secretsSurface} (internal)`);
    lines.push(`  - critical assets: ${report.generatedSections.criticalAssets} (internal)`);
    lines.push(`- current changed-file entry points: ${inlineList(report.changedEntryPoints)}`);
    lines.push(`- added by persisted model: ${inlineList(report.addedEntryPoints)}`);
    lines.push(`- removed by persisted model: ${inlineList(report.removedEntryPoints)}`);
  }
  lines.push("");
  lines.push("## How to read this");
  lines.push("");
  lines.push(
    "Each repo replays at most one HIGH/CRITICAL agreed finding twice: current changed-file-only context, then the same finding with persisted threat-model entry points supplied to the gate. The added/removed lists show the input-context delta behind those verdicts.",
  );
  return `${lines.join("\n")}\n`;
}

function inlineList(values: string[]): string {
  if (values.length === 0) return "_none_";
  return values
    .slice(0, 8)
    .map((value) => `\`${value}\``)
    .join(", ");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
