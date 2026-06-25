import type { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { AUTONOMOPOLY_AGENT } from "@/lib/agent-registry";
import { jsonError, jsonStats, optionsResponse } from "@/lib/api-v1/responses";
import { iso } from "@/lib/api-v1/serialize";
import { rawCyberTierExclusionForFullName } from "@/lib/cyber-tier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StatsBody = {
  total_findings: number;
  findings_by_severity: { info: number; low: number; med: number; high: number };
  total_agents: number;
  agents_with_findings: number;
  total_drift_snapshots: number;
  latest_finding_at: string | null;
  generated_at: string;
};

type StatsRow = {
  total_findings: number | string;
  info_findings: number | string;
  low_findings: number | string;
  med_findings: number | string;
  high_findings: number | string;
  total_agents: number | string;
  agents_with_findings: number | string;
  total_drift_snapshots: number | string;
  latest_finding_at: Date | string | null;
};

export type StatsDeps = {
  loadStats: (generatedAt: Date) => Promise<StatsBody>;
};

const DEFAULT_DEPS: StatsDeps = {
  async loadStats(generatedAt) {
    // Cyber-tier exclusion threaded into BOTH the directory CTE (so
    // cyber-only agents are not counted in total_agents) and the
    // public_findings CTE (so cyber findings do not appear in
    // total_findings / severity buckets / agents_with_findings /
    // latest_finding_at). Existence-hiding at the aggregate level
    // requires both CTEs to filter consistently — counts that include
    // cyber rows but rows that don't reveal a sudden delta when a
    // cyber finding lands. (Code audit pass-2, severity medium.)
    const cyberExclude = rawCyberTierExclusionForFullName(sql`repo_full_name`);
    const result = await db.execute(sql`
      WITH directory AS (
        SELECT ${AUTONOMOPOLY_AGENT.address}::text AS address
        WHERE true ${rawCyberTierExclusionForFullName(sql`${AUTONOMOPOLY_AGENT.repo}::text`)}
        UNION
        SELECT token_address FROM factory_launches WHERE prelaunch_status = 'published' ${cyberExclude}
        UNION
        SELECT agent_token_address FROM agent_findings WHERE agent_token_address NOT LIKE 'roast:%' ${cyberExclude}
      ),
      public_findings AS (
        SELECT * FROM agent_findings WHERE agent_token_address NOT LIKE 'roast:%' ${cyberExclude}
      )
      SELECT
        (SELECT count(*)::int FROM public_findings) AS total_findings,
        (SELECT count(*)::int FROM public_findings WHERE severity = 'info') AS info_findings,
        (SELECT count(*)::int FROM public_findings WHERE severity = 'low') AS low_findings,
        (SELECT count(*)::int FROM public_findings WHERE severity = 'med') AS med_findings,
        (SELECT count(*)::int FROM public_findings WHERE severity = 'high') AS high_findings,
        (SELECT count(*)::int FROM directory) AS total_agents,
        (SELECT count(DISTINCT lower(agent_token_address))::int FROM public_findings) AS agents_with_findings,
        (SELECT count(*)::int FROM drift_snapshots) AS total_drift_snapshots,
        (SELECT max(published_at) FROM public_findings) AS latest_finding_at
    `);
    const row = sqlRows<StatsRow>(result)[0];
    if (row === undefined) throw new Error("stats query returned no row");
    return {
      total_findings: numberFromSql(row.total_findings),
      findings_by_severity: {
        info: numberFromSql(row.info_findings),
        low: numberFromSql(row.low_findings),
        med: numberFromSql(row.med_findings),
        high: numberFromSql(row.high_findings),
      },
      total_agents: numberFromSql(row.total_agents),
      agents_with_findings: numberFromSql(row.agents_with_findings),
      total_drift_snapshots: numberFromSql(row.total_drift_snapshots),
      latest_finding_at: row.latest_finding_at === null ? null : iso(row.latest_finding_at),
      generated_at: generatedAt.toISOString(),
    };
  },
};

export async function GET(req: NextRequest) {
  return handleStats(req, DEFAULT_DEPS);
}

export function OPTIONS() {
  return optionsResponse();
}

export async function handleStats(_req: NextRequest, deps: StatsDeps) {
  try {
    return jsonStats(await deps.loadStats(new Date()));
  } catch {
    return jsonError(500, "internal", "internal error");
  }
}

function numberFromSql(value: number | string): number {
  return typeof value === "number" ? value : Number.parseInt(value, 10);
}

function sqlRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (typeof result === "object" && result !== null && "rows" in result) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
