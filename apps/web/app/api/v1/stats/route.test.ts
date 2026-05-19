import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { handleStats, type StatsDeps } from "./route";

describe("GET /api/v1/stats", () => {
  it("returns the documented flat shape", async () => {
    const res = await handleStats(new NextRequest("http://test.local/api/v1/stats"), deps());
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(Object.keys(body).sort()).toEqual([
      "agents_with_findings",
      "findings_by_severity",
      "generated_at",
      "latest_finding_at",
      "total_agents",
      "total_drift_snapshots",
      "total_findings",
    ]);
  });

  it("returns internal on loader failure", async () => {
    const res = await handleStats(new NextRequest("http://test.local/api/v1/stats"), {
      loadStats: async () => {
        throw new Error("boom");
      },
    });
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

function deps(): StatsDeps {
  return {
    loadStats: async (generatedAt) => ({
      total_findings: 1,
      findings_by_severity: { info: 0, low: 0, med: 0, high: 1 },
      total_agents: 1,
      agents_with_findings: 1,
      total_drift_snapshots: 0,
      latest_finding_at: "2026-05-18T00:00:00.000Z",
      generated_at: generatedAt.toISOString(),
    }),
  };
}
