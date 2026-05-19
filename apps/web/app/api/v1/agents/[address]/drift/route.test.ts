import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { handleAgentDrift, type AgentDriftDeps } from "./route";
import type { DriftRow } from "@/lib/api-v1/serialize";

const address = "0x0000000000000000000000000000000000000001";
const rows = [
  drift("d1", "2026-05-18T03:00:00.000Z"),
  drift("d2", "2026-05-18T02:00:00.000Z"),
  drift("d3", "2026-05-18T01:00:00.000Z"),
];

describe("GET /api/v1/agents/:address/drift", () => {
  it("returns the documented shape", async () => {
    const res = await handleAgentDrift(req("?limit=2"), { address }, deps(true, rows));
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=60, stale-while-revalidate=300");
    expect(Object.keys(body.data[0] ?? {}).toSorted()).toEqual([
      "agent_token_address",
      "commit_sha",
      "commit_timestamp",
      "drift_score",
      "id",
      "observed_at",
      "threshold",
    ]);
  });

  it("returns 404 for an unknown agent", async () => {
    const res = await handleAgentDrift(req(""), { address }, deps(false, rows));
    expect(res.status).toBe(404);
  });

  it("walks cursor pages without duplicates", async () => {
    const ids: string[] = [];
    let suffix = "?limit=1";
    for (let i = 0; i < 3; i += 1) {
      const res = await handleAgentDrift(req(suffix), { address }, deps(true, rows));
      const body = (await res.json()) as { data: { id: string }[]; next_cursor: string | null };
      ids.push(body.data[0]!.id);
      suffix = `?limit=1&cursor=${body.next_cursor ?? ""}`;
    }
    expect(ids).toEqual(["d1", "d2", "d3"]);
    expect(new Set(ids).size).toBe(3);
  });
});

function deps(exists: boolean, source: DriftRow[]): AgentDriftDeps {
  return {
    agentExists: async () => exists,
    async listDrift(_address, query, cursor) {
      const start = cursor === null ? 0 : source.findIndex((row) => row.id === cursor[1]) + 1;
      const page = source.slice(start, start + query.limit + 1);
      const data = page.slice(0, query.limit);
      const last = data[data.length - 1];
      return {
        rows: data,
        nextCursor:
          page.length > query.limit && last
            ? Buffer.from(JSON.stringify([last.commitTimestamp, last.id])).toString("base64url")
            : null,
      };
    },
  };
}

function req(suffix: string): NextRequest {
  return new NextRequest(`http://test.local/api/v1/agents/${address}/drift${suffix}`);
}

function drift(id: string, commitTimestamp: string): DriftRow {
  return {
    id,
    agentTokenAddress: address,
    commitSha: "abc",
    commitTimestamp,
    driftScore: "0.12",
    threshold: "0.30",
    observedAt: commitTimestamp,
  };
}
