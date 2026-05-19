import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { handleAgentFindings, type AgentFindingsDeps } from "./route";
import type { FindingRow } from "@/lib/api-v1/serialize";

const address = "0x0000000000000000000000000000000000000001";
const rows = [
  finding("f1", "2026-05-18T03:00:00.000Z"),
  finding("f2", "2026-05-18T02:00:00.000Z"),
  finding("f3", "2026-05-18T01:00:00.000Z"),
];

describe("GET /api/v1/agents/:address/findings", () => {
  it("returns the documented shape", async () => {
    const res = await handleAgentFindings(req("?limit=2"), { address }, deps(true, rows));
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=60, stale-while-revalidate=300");
    expect(Object.keys(body.data[0] ?? {}).toSorted()).toContain("finding_id");
  });

  it("returns 404 for an unknown agent", async () => {
    const res = await handleAgentFindings(req(""), { address }, deps(false, rows));
    expect(res.status).toBe(404);
  });

  it("walks cursor pages without duplicates", async () => {
    const ids: string[] = [];
    let suffix = "?limit=1";
    for (let i = 0; i < 3; i += 1) {
      const res = await handleAgentFindings(req(suffix), { address }, deps(true, rows));
      const body = (await res.json()) as { data: { finding_id: string }[]; next_cursor: string | null };
      ids.push(body.data[0]!.finding_id);
      suffix = `?limit=1&cursor=${body.next_cursor ?? ""}`;
    }
    expect(ids).toEqual(["f1", "f2", "f3"]);
    expect(new Set(ids).size).toBe(3);
  });
});

function deps(exists: boolean, source: FindingRow[]): AgentFindingsDeps {
  return {
    agentExists: async () => exists,
    async listFindings(_address, query, cursor) {
      const start = cursor === null ? 0 : source.findIndex((row) => row.findingId === cursor[1]) + 1;
      const page = source.slice(start, start + query.limit + 1);
      const data = page.slice(0, query.limit);
      const last = data[data.length - 1];
      return {
        rows: data,
        nextCursor:
          page.length > query.limit && last
            ? Buffer.from(JSON.stringify([last.publishedAt, last.findingId])).toString("base64url")
            : null,
      };
    },
  };
}

function req(suffix: string): NextRequest {
  return new NextRequest(`http://test.local/api/v1/agents/${address}/findings${suffix}`);
}

function finding(findingId: string, publishedAt: string): FindingRow {
  return {
    findingId,
    agentTokenAddress: address,
    agentName: "agent",
    repoFullName: "owner/repo",
    title: "Title",
    severity: "high",
    summary: "summary",
    evidence: null,
    upstreamPrUrl: null,
    upstreamMergedSha: null,
    publishedAt,
  };
}
