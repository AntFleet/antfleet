import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { decodeCursor } from "@/lib/api-v1/cursor";
import { handleFindings, pageFindings, type FindingsDeps } from "./route";
import type { FindingRow } from "@/lib/api-v1/serialize";

const rows: FindingRow[] = [
  finding("f1", "2026-05-18T03:00:00.000Z"),
  finding("f2", "2026-05-18T02:00:00.000Z"),
  finding("f3", "2026-05-18T01:00:00.000Z"),
];

describe("GET /api/v1/findings", () => {
  it("returns the documented shape", async () => {
    const res = await handleFindings(req("http://test.local/api/v1/findings?limit=2"), deps(rows));
    const body = (await res.json()) as {
      data: Record<string, unknown>[];
      next_cursor: string | null;
    };
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=300",
    );
    expect(Object.keys(body.data[0] ?? {}).toSorted()).toEqual([
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

  it("rejects invalid cursors", async () => {
    const res = await handleFindings(
      req("http://test.local/api/v1/findings?cursor=bad"),
      deps(rows),
    );
    expect(res.status).toBe(400);
  });

  it("walks cursor pages without duplicates", async () => {
    const ids: string[] = [];
    let url = "http://test.local/api/v1/findings?limit=1";
    for (let i = 0; i < 3; i += 1) {
      const res = await handleFindings(req(url), deps(rows));
      const body = (await res.json()) as {
        data: { finding_id: string }[];
        next_cursor: string | null;
      };
      ids.push(body.data[0]!.finding_id);
      if (body.next_cursor !== null)
        url = `http://test.local/api/v1/findings?limit=1&cursor=${body.next_cursor}`;
    }
    expect(ids).toEqual(["f1", "f2", "f3"]);
    expect(new Set(ids).size).toBe(3);
  });

  it("preserves raw sub-millisecond timestamps in next cursors", () => {
    const page = pageFindings(
      [
        finding("f1", "2026-05-18T03:00:00.123456Z"),
        finding("f2", "2026-05-18T03:00:00.123455Z"),
      ],
      1,
    );

    expect(decodeCursor(page.nextCursor!, 2)).toEqual([
      "2026-05-18T03:00:00.123456Z",
      "f1",
    ]);
  });
});

function deps(source: FindingRow[]): FindingsDeps {
  return {
    async listFindings(query, cursor) {
      const start =
        cursor === null ? 0 : source.findIndex((row) => row.findingId === cursor[1]) + 1;
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

function req(url: string): NextRequest {
  return new NextRequest(url);
}

function finding(findingId: string, publishedAt: string): FindingRow {
  return {
    findingId,
    agentTokenAddress: "0x0000000000000000000000000000000000000001",
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
