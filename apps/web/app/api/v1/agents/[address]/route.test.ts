import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { handleAgentDetail, type AgentDetailDeps } from "./route";
import type { AgentDetailRow } from "@/lib/api-v1/serialize";

const address = "0x0000000000000000000000000000000000000001";

describe("GET /api/v1/agents/:address", () => {
  it("returns the documented shape", async () => {
    const res = await handleAgentDetail(new NextRequest("http://test.local"), { address }, deps(row));
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300, stale-while-revalidate=3600");
    expect(Object.keys(body.data).sort()).toEqual([
      "address",
      "drift",
      "findings_count",
      "first_seen_at",
      "latest_finding_at",
      "name",
      "repo_full_name",
      "source",
    ]);
  });

  it("returns 404 when missing", async () => {
    const res = await handleAgentDetail(new NextRequest("http://test.local"), { address }, deps(null));
    expect(res.status).toBe(404);
  });
});

const row: AgentDetailRow = {
  address,
  name: "agent",
  repoFullName: "owner/repo",
  source: "registry",
  firstSeenAt: "2026-05-19T00:00:00.000Z",
  findingsCount: 1,
  latestFindingAt: null,
  drift: { snapshotsCount: 0, latestObservedAt: null, latestDriftScore: null },
};

function deps(result: AgentDetailRow | null): AgentDetailDeps {
  return { getAgent: async () => result };
}
