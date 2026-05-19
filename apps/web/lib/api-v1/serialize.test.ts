import { describe, expect, it } from "vitest";
import {
  serializeAgentDetail,
  serializeDriftSnapshot,
  serializeFinding,
  type AgentDetailRow,
  type DriftRow,
  type FindingRow,
} from "./serialize";

const redactedKeys = [
  "ip_hash",
  "submitter_email",
  "submitter_handle",
  "rejection_reason",
  "claimer_signature",
  "claimer_address",
  "verified_at",
  "repo_hash",
  "installation_id",
  "processing_status",
  "processing_attempts",
  "processing_started_at",
  "processing_finished_at",
  "next_retry_at",
  "processing_error",
  "deployer_address",
  "tx_hash",
  "repo_discovery_method",
  "prelaunch_status",
  "prelaunch_finding_id",
  "tool_output",
  "prompt",
];

describe("api v1 serializers", () => {
  it("serializes findings without redacted keys", () => {
    const row: FindingRow = {
      findingId: "f1",
      agentTokenAddress: "0x0000000000000000000000000000000000000001",
      agentName: "agent",
      repoFullName: "owner/repo",
      title: "Title",
      severity: "high",
      summary: "summary",
      evidence: null,
      upstreamPrUrl: null,
      upstreamMergedSha: null,
      publishedAt: new Date("2026-05-18T00:00:00.000Z"),
    };
    const output = serializeFinding(row);
    expect(Object.keys(output).toSorted()).toMatchInlineSnapshot(`
      [
        "agent_name",
        "agent_token_address",
        "evidence",
        "finding_id",
        "published_at",
        "repo_full_name",
        "severity",
        "summary",
        "title",
        "upstream_merged_sha",
        "upstream_pr_url",
      ]
    `);
    expect(Object.keys(output).some((key) => redactedKeys.includes(key))).toBe(false);
  });

  it("serializes agent detail without redacted keys", () => {
    const row: AgentDetailRow = {
      address: "0x0000000000000000000000000000000000000001",
      name: "agent",
      repoFullName: "owner/repo",
      source: "registry",
      firstSeenAt: "2026-05-19T00:00:00.000Z",
      findingsCount: 1,
      latestFindingAt: null,
      drift: { snapshotsCount: 0, latestObservedAt: null, latestDriftScore: null },
    };
    const output = serializeAgentDetail(row);
    expect(Object.keys(output).toSorted()).toMatchInlineSnapshot(`
      [
        "address",
        "drift",
        "findings_count",
        "first_seen_at",
        "latest_finding_at",
        "name",
        "repo_full_name",
        "source",
      ]
    `);
    expect(JSON.stringify(output)).not.toContain("prelaunch_status");
  });

  it("serializes drift snapshots without redacted keys", () => {
    const row: DriftRow = {
      id: "d1",
      agentTokenAddress: "0x0000000000000000000000000000000000000001",
      commitSha: "abc",
      commitTimestamp: "2026-05-18T00:00:00.000Z",
      driftScore: "0.12",
      threshold: "0.30",
      observedAt: "2026-05-18T00:00:01.000Z",
    };
    const output = serializeDriftSnapshot(row);
    expect(Object.keys(output).some((key) => redactedKeys.includes(key))).toBe(false);
  });
});
