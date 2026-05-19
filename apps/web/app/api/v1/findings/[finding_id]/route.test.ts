import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { handleFindingDetail, type FindingDetailDeps } from "./route";
import type { FindingRow } from "@/lib/api-v1/serialize";

describe("GET /api/v1/findings/:finding_id", () => {
  it("returns the documented shape", async () => {
    const res = await handleFindingDetail(new NextRequest("http://test.local"), { finding_id: "f1" }, deps(row));
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300, stale-while-revalidate=3600");
    expect(Object.keys(body.data).sort()).toEqual([
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
    ]);
  });

  it("returns 404 when missing", async () => {
    const res = await handleFindingDetail(new NextRequest("http://test.local"), { finding_id: "missing" }, deps(null));
    expect(res.status).toBe(404);
  });
});

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
  publishedAt: "2026-05-18T00:00:00.000Z",
};

function deps(result: FindingRow | null): FindingDetailDeps {
  return { getFinding: async () => result };
}
