import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { handleAgents, type AgentsDeps } from "./route";
import type { AgentListRow } from "@/lib/api-v1/serialize";

const rows: AgentListRow[] = [
  agent("0x0000000000000000000000000000000000000001", "2026-05-19T03:00:00.000Z"),
  agent("0x0000000000000000000000000000000000000002", "2026-05-19T02:00:00.000Z"),
  agent("0x0000000000000000000000000000000000000003", "2026-05-19T01:00:00.000Z"),
];

describe("GET /api/v1/agents", () => {
  it("returns the documented shape", async () => {
    const res = await handleAgents(new NextRequest("http://test.local/api/v1/agents?limit=2"), deps(rows));
    const body = (await res.json()) as { data: Record<string, unknown>[]; next_cursor: string | null };
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=60, stale-while-revalidate=300");
    expect(Object.keys(body.data[0] ?? {}).toSorted()).toEqual([
      "address",
      "findings_count",
      "first_seen_at",
      "latest_finding_at",
      "name",
      "repo_full_name",
      "source",
    ]);
  });

  it("rejects invalid limit", async () => {
    const res = await handleAgents(new NextRequest("http://test.local/api/v1/agents?limit=101"), deps(rows));
    expect(res.status).toBe(400);
  });

  it("walks cursor pages without duplicates", async () => {
    const ids: string[] = [];
    let url = "http://test.local/api/v1/agents?limit=1";
    for (let i = 0; i < 3; i += 1) {
      const res = await handleAgents(new NextRequest(url), deps(rows));
      const body = (await res.json()) as { data: { address: string }[]; next_cursor: string | null };
      ids.push(body.data[0]!.address);
      if (body.next_cursor !== null) url = `http://test.local/api/v1/agents?limit=1&cursor=${body.next_cursor}`;
    }
    expect(ids).toEqual(rows.map((row) => row.address));
    expect(new Set(ids).size).toBe(3);
  });
});

function deps(source: AgentListRow[]): AgentsDeps {
  return {
    async listAgents(query, cursor) {
      const start = cursor === null ? 0 : source.findIndex((row) => row.address === cursor[1]) + 1;
      const page = source.slice(start, start + query.limit + 1);
      const data = page.slice(0, query.limit);
      const last = data[data.length - 1];
      return {
        rows: data,
        nextCursor:
          page.length > query.limit && last
            ? Buffer.from(JSON.stringify([last.firstSeenAt, last.address])).toString("base64url")
            : null,
      };
    },
  };
}

function agent(address: string, firstSeenAt: string): AgentListRow {
  return {
    address,
    name: "agent",
    repoFullName: "owner/repo",
    source: "registry",
    firstSeenAt,
    findingsCount: 1,
    latestFindingAt: null,
  };
}
