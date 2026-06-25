import { sql } from "drizzle-orm";
import { db } from "@/db/index";
import { agentFindings, driftSnapshots } from "@/db/schema";
import { loadRepoSubmissionStats } from "./agent-submissions";
import type { AgentRegistryEntry } from "./agent-registry";
import { isCyberTierRepo } from "./cyber-tier";
import { writePostDraft } from "./post-drafts";

const USER_AGENT = "antfleet-depth-track";
const SPIKE_MARGIN = 0.05;

export type IdentityFetchResult =
  | {
      ok: true;
      content: string;
      parsed: Record<string, unknown>;
      fetchedAt: Date;
    }
  | {
      ok: false;
      fetchedAt: Date;
      error: string;
    };

type GitHubCommit = {
  sha: string;
  commit: {
    author: {
      date: string;
    } | null;
  };
};

function githubHeaders(): HeadersInit {
  const token = process.env["ANTFLEET_OPS_GH_TOKEN"];
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    ...(token !== undefined && token.length > 0 ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchGitHubText(repo: string, filePath: string, ref = "HEAD"): Promise<string> {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const url = `https://api.github.com/repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
  const resp = await fetch(url, { headers: githubHeaders(), cache: "no-store" });
  if (!resp.ok) {
    throw new Error(`GitHub content fetch failed: ${resp.status}`);
  }
  const data = (await resp.json()) as { content?: string; encoding?: string };
  if (data.encoding !== "base64" || data.content === undefined) {
    throw new Error("GitHub content response was not base64 file content");
  }
  return Buffer.from(data.content, "base64").toString("utf8");
}

export async function fetchIdentityFile(agent: AgentRegistryEntry): Promise<IdentityFetchResult> {
  const fetchedAt = new Date();
  try {
    const content = await fetchGitHubText(agent.repo, agent.identityFile);
    return { ok: true, content, parsed: JSON.parse(content) as Record<string, unknown>, fetchedAt };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, fetchedAt, error };
  }
}

export async function fetchSoulGenesis(agent: AgentRegistryEntry): Promise<string> {
  return fetchGitHubText(agent.repo, "identity/SOUL.genesis.md");
}

function tokens(input: string): Set<string> {
  return new Set(
    input
      .toLowerCase()
      .split(/[\s\p{P}\p{S}]+/u)
      .filter(Boolean),
  );
}

export function jaccardDistance(a: string, b: string): number {
  // Jaccard distance over lowercase whitespace/punctuation tokens tracks narrative drift.
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 && right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = new Set([...left, ...right]).size;
  return 1 - intersection / union;
}

export function identityThreshold(parsed: Record<string, unknown>): number {
  const value = parsed["drift_threshold"];
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsedValue = Number(value);
    if (Number.isFinite(parsedValue)) return parsedValue;
  }
  return 0.25;
}

async function listIdentityCommits(agent: AgentRegistryEntry): Promise<GitHubCommit[]> {
  const url = `https://api.github.com/repos/${agent.repo}/commits?path=${encodeURIComponent(agent.identityFile)}&per_page=100`;
  const resp = await fetch(url, { headers: githubHeaders(), cache: "no-store" });
  if (!resp.ok) {
    throw new Error(`GitHub commit fetch failed: ${resp.status}`);
  }
  return (await resp.json()) as GitHubCommit[];
}

async function insertDriftSnapshot(args: {
  agent: AgentRegistryEntry;
  commitSha: string;
  commitTimestamp: Date;
  driftScore: number;
  threshold: number;
  observedAt: Date;
}): Promise<boolean> {
  const id = `${args.agent.address.toLowerCase()}:${args.commitSha}`;
  const inserted = await db
    .insert(driftSnapshots)
    .values({
      id,
      agentTokenAddress: args.agent.address,
      commitSha: args.commitSha,
      commitTimestamp: args.commitTimestamp,
      driftScore: args.driftScore.toFixed(6),
      threshold: args.threshold.toFixed(6),
      observedAt: args.observedAt,
    })
    .onConflictDoNothing({ target: driftSnapshots.id })
    .returning({ id: driftSnapshots.id });
  return inserted.length > 0;
}

async function recordDriftSpikeFinding(
  agent: AgentRegistryEntry,
  driftScore: number,
  threshold: number,
): Promise<void> {
  const findingId = `identity-drift-${new Date().toISOString().slice(0, 10)}`;
  await db
    .insert(agentFindings)
    .values({
      findingId,
      agentTokenAddress: agent.address,
      agentName: agent.name,
      repoFullName: agent.repo,
      title: "identity drift approaching declared threshold",
      severity: "med",
      summary: `Current identity drift is ${driftScore.toFixed(3)} against the declared threshold ${threshold.toFixed(3)}.`,
      evidence: `Computed from ${agent.identityFile} against identity/SOUL.genesis.md.`,
    })
    .onConflictDoNothing({ target: agentFindings.findingId });
  await writePostDraft({
    slug: findingId,
    title: "Identity drift approaching declared threshold",
    body: `${agent.name} drift is ${driftScore.toFixed(3)} against its declared ${threshold.toFixed(3)} threshold.`,
  });
}

export async function backfillIdentityDrift(agent: AgentRegistryEntry): Promise<{
  checked: number;
  inserted: number;
  spikes: number;
}> {
  const [genesis, commits] = await Promise.all([
    fetchSoulGenesis(agent),
    listIdentityCommits(agent),
  ]);
  let inserted = 0;
  let spikes = 0;
  for (const commit of commits.toReversed()) {
    const timestamp = commit.commit.author?.date;
    if (timestamp === undefined) continue;
    const identityContent = await fetchGitHubText(agent.repo, agent.identityFile, commit.sha);
    const parsed = JSON.parse(identityContent) as Record<string, unknown>;
    const threshold = identityThreshold(parsed);
    const driftScore = jaccardDistance(genesis, identityContent);
    const didInsert = await insertDriftSnapshot({
      agent,
      commitSha: commit.sha,
      commitTimestamp: new Date(timestamp),
      driftScore,
      threshold,
      observedAt: new Date(),
    });
    if (didInsert) {
      inserted += 1;
      if (threshold - driftScore >= 0 && threshold - driftScore <= SPIKE_MARGIN) {
        spikes += 1;
        await recordDriftSpikeFinding(agent, driftScore, threshold);
      }
    }
  }
  return { checked: commits.length, inserted, spikes };
}

export async function loadDriftSnapshots(address: string): Promise<
  Array<{
    commitSha: string;
    commitTimestamp: Date;
    driftScore: number;
    threshold: number;
  }>
> {
  const normalized = address.toLowerCase();
  const rows = await db
    .select({
      commitSha: driftSnapshots.commitSha,
      commitTimestamp: driftSnapshots.commitTimestamp,
      driftScore: driftSnapshots.driftScore,
      threshold: driftSnapshots.threshold,
    })
    .from(driftSnapshots)
    .where(sql`lower(${driftSnapshots.agentTokenAddress}) = ${normalized}`)
    .orderBy(driftSnapshots.commitTimestamp);

  return rows.map((row) => ({
    commitSha: row.commitSha,
    commitTimestamp: row.commitTimestamp,
    driftScore: Number(row.driftScore),
    threshold: Number(row.threshold),
  }));
}

export async function countFindingsForRepo(repoFullName: string): Promise<number> {
  // Cyber-tier exclusion: when a repo is classified cyber the public
  // /badge/[owner]/[repo].svg surface must NOT reveal the finding count
  // — neither agent_findings rows NOR the static submission ledger may
  // contribute. The badge renders "0 findings, not yet reviewed" which
  // is the same shape as any unreviewed repo, so existence is hidden.
  // Code audit pass-2 + pass-4: pass-4 caught the bug that the prior
  // fix still returned submission totals (could be nonzero, revealing
  // a known-tracked repo). When ANTFLEET_CYBER_TIER is OFF this branch
  // never runs and behavior is byte-identical.
  if (await isCyberTierRepo(...repoFullNameToOwnerRepo(repoFullName))) {
    return 0;
  }
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentFindings)
    .where(sql`lower(${agentFindings.repoFullName}) = ${repoFullName.toLowerCase()}`);
  return Math.max(rows[0]?.count ?? 0, loadRepoSubmissionStats(repoFullName).total);
}

function repoFullNameToOwnerRepo(fullName: string): [string, string] {
  const slash = fullName.indexOf("/");
  if (slash <= 0 || slash === fullName.length - 1) return [fullName, ""];
  return [fullName.slice(0, slash), fullName.slice(slash + 1)];
}

export function isNearThreshold(score: number, threshold: number): boolean {
  return threshold - score >= 0 && threshold - score <= SPIKE_MARGIN;
}
