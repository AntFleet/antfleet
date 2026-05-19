import type { AgentRegistryEntry } from "@/lib/agent-registry";

export type FindingRow = {
  findingId: string;
  agentTokenAddress: string;
  agentName: string;
  repoFullName: string | null;
  title: string;
  severity: string;
  summary: string;
  evidence: string | null;
  upstreamPrUrl: string | null;
  upstreamMergedSha: string | null;
  publishedAt: Date | string;
};

export type DriftRow = {
  id: string;
  agentTokenAddress: string;
  commitSha: string;
  commitTimestamp: Date | string;
  driftScore: string;
  threshold: string;
  observedAt: Date | string;
};

export type AgentListRow = {
  address: string;
  name: string;
  repoFullName: string | null;
  source: "registry" | "factory";
  firstSeenAt: Date | string;
  findingsCount: number;
  latestFindingAt: Date | string | null;
};

export type AgentDetailRow = AgentListRow & {
  drift: {
    snapshotsCount: number;
    latestObservedAt: Date | string | null;
    latestDriftScore: string | null;
  };
};

export function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function serializeFinding(row: FindingRow) {
  return {
    finding_id: row.findingId,
    agent_token_address: row.agentTokenAddress,
    agent_name: row.agentName,
    repo_full_name: row.repoFullName,
    title: row.title,
    severity: row.severity,
    summary: row.summary,
    evidence: row.evidence,
    upstream_pr_url: row.upstreamPrUrl,
    upstream_merged_sha: row.upstreamMergedSha,
    published_at: iso(row.publishedAt),
  };
}

export function serializeAgent(row: AgentListRow) {
  return {
    address: row.address,
    name: row.name,
    repo_full_name: row.repoFullName,
    source: row.source,
    first_seen_at: iso(row.firstSeenAt),
    findings_count: row.findingsCount,
    latest_finding_at: row.latestFindingAt === null ? null : iso(row.latestFindingAt),
  };
}

export function serializeAgentDetail(row: AgentDetailRow) {
  return {
    ...serializeAgent(row),
    drift: {
      snapshots_count: row.drift.snapshotsCount,
      latest_observed_at:
        row.drift.latestObservedAt === null ? null : iso(row.drift.latestObservedAt),
      latest_drift_score: row.drift.latestDriftScore,
    },
  };
}

export function serializeDriftSnapshot(row: DriftRow) {
  return {
    id: row.id,
    agent_token_address: row.agentTokenAddress,
    commit_sha: row.commitSha,
    commit_timestamp: iso(row.commitTimestamp),
    drift_score: row.driftScore,
    threshold: row.threshold,
    observed_at: iso(row.observedAt),
  };
}

export function registryAgentRow(
  agent: AgentRegistryEntry,
  stats?: {
    findingsCount: number;
    latestFindingAt: Date | string | null;
  },
): AgentListRow {
  return {
    address: agent.address,
    name: agent.name,
    repoFullName: agent.repo,
    source: "registry",
    firstSeenAt: "2026-05-19T00:00:00.000Z",
    findingsCount: stats?.findingsCount ?? 0,
    latestFindingAt: stats?.latestFindingAt ?? null,
  };
}
