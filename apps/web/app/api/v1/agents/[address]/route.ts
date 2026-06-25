import type { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { findAgentByAddress } from "@/lib/agent-registry";
import { DETAIL_CACHE, jsonError, jsonOk, optionsResponse } from "@/lib/api-v1/responses";
import {
  registryAgentRow,
  serializeAgentDetail,
  type AgentDetailRow,
  type AgentListRow,
} from "@/lib/api-v1/serialize";
import { loadAgentSubmissionStatsExcludingCyber } from "@/lib/agent-submissions";
import { isCyberTierRepo, rawCyberTierExclusionForFullName } from "@/lib/cyber-tier";

function splitRepoFullName(fullName: string): [string, string] {
  const slash = fullName.indexOf("/");
  if (slash <= 0 || slash === fullName.length - 1) return [fullName, ""];
  return [fullName.slice(0, slash), fullName.slice(slash + 1)];
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ address: z.string().regex(/^0x[a-fA-F0-9]{40}$/u) });

type StatsRow = {
  findings_count: number | string;
  latest_finding_at: Date | string | null;
  snapshots_count: number | string;
  latest_observed_at: Date | string | null;
  latest_drift_score: string | null;
};

type FactoryRow = {
  address: string;
  name: string;
  repo_full_name: string | null;
  first_seen_at: Date | string;
};

type FindingAgentRow = {
  address: string;
  name: string;
  repo_full_name: string | null;
  first_seen_at: Date | string;
};

export type AgentDetailDeps = {
  getAgent: (address: string) => Promise<AgentDetailRow | null>;
};

const DEFAULT_DEPS: AgentDetailDeps = {
  async getAgent(address) {
    const normalized = address.toLowerCase();
    const registry = findAgentByAddress(address);
    let base: AgentListRow | null = null;
    if (registry !== null) {
      // Hardcoded registry repo can still be classified cyber. Hide the
      // detail endpoint entirely (404) when the registry entry maps to
      // a cyber-classified repo. (Security audit pass-4, severity high,
      // information-disclosure.)
      if (registry.repo !== null && (await isCyberTierRepo(...splitRepoFullName(registry.repo)))) {
        return null;
      }
      base = registryAgentRow(registry);
    } else {
      // Cyber-tier exclusion on factory directory lookup: a cyber-
      // classified factory-launched repo's owner/repo + token must not
      // be returned via the public v1 agent detail endpoint. (Security
      // audit pass-4, severity high, information-disclosure.)
      const factoryCyberExclude = rawCyberTierExclusionForFullName(sql`repo_full_name`);
      const factoryResult = await db.execute(sql`
        SELECT
          token_address AS address,
          coalesce(token_name, token_symbol, token_address) AS name,
          repo_full_name,
          deployed_at AS first_seen_at
        FROM factory_launches
        WHERE lower(token_address) = ${normalized}
          AND prelaunch_status = 'published'
          ${factoryCyberExclude}
        LIMIT 1
      `);
      const factory = sqlRows<FactoryRow>(factoryResult)[0];
      if (factory !== undefined) {
        base = {
          address: factory.address,
          name: factory.name,
          repoFullName: factory.repo_full_name,
          source: "factory",
          firstSeenAt: factory.first_seen_at,
          findingsCount: 0,
          latestFindingAt: null,
        };
      } else {
        const findingResult = await db.execute(sql`
          WITH public_findings AS (
            SELECT *
            FROM agent_findings
            WHERE lower(agent_token_address) = ${normalized}
              AND agent_token_address NOT LIKE 'roast:%'
              ${rawCyberTierExclusionForFullName(sql`repo_full_name`)}
          )
          SELECT
            latest.agent_token_address AS address,
            latest.agent_name AS name,
            latest.repo_full_name,
            stats.first_seen_at
          FROM (
            SELECT DISTINCT ON (lower(agent_token_address))
              agent_token_address,
              agent_name,
              repo_full_name
            FROM public_findings
            ORDER BY lower(agent_token_address), published_at DESC, finding_id ASC
          ) latest
          CROSS JOIN (
            SELECT min(published_at) AS first_seen_at FROM public_findings
          ) stats
          LIMIT 1
        `);
        const findingAgent = sqlRows<FindingAgentRow>(findingResult)[0];
        if (findingAgent === undefined) return null;
        base = {
          address: findingAgent.address,
          name: findingAgent.name,
          repoFullName: findingAgent.repo_full_name,
          source: "registry",
          firstSeenAt: findingAgent.first_seen_at,
          findingsCount: 0,
          latestFindingAt: null,
        };
      }
    }

    // Cyber-tier exclusion threaded into the agent_findings count + max
    // subqueries so cyber-classified rows do not contribute to the
    // public agent's `findingsCount` / `latestFindingAt`. Drift snapshot
    // counts are not gated — drift is a property of the agent identity
    // (token address), not the repo, and the existing identity-drift
    // surfaces are unrelated to cyber-repo existence hiding.
    const cyberExclude = rawCyberTierExclusionForFullName(sql`repo_full_name`);
    const statsResult = await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM agent_findings WHERE lower(agent_token_address) = ${normalized} AND agent_token_address NOT LIKE 'roast:%' ${cyberExclude}) AS findings_count,
        (SELECT max(published_at) FROM agent_findings WHERE lower(agent_token_address) = ${normalized} AND agent_token_address NOT LIKE 'roast:%' ${cyberExclude}) AS latest_finding_at,
        (SELECT count(*)::int FROM drift_snapshots WHERE lower(agent_token_address) = ${normalized}) AS snapshots_count,
        (SELECT observed_at FROM drift_snapshots WHERE lower(agent_token_address) = ${normalized} ORDER BY observed_at DESC, id ASC LIMIT 1) AS latest_observed_at,
        (SELECT drift_score FROM drift_snapshots WHERE lower(agent_token_address) = ${normalized} ORDER BY observed_at DESC, id ASC LIMIT 1) AS latest_drift_score
    `);
    const stats = sqlRows<StatsRow>(statsResult)[0] ?? {
      findings_count: 0,
      latest_finding_at: null,
      snapshots_count: 0,
      latest_observed_at: null,
      latest_drift_score: null,
    };
    return {
      ...base,
      ...(await applySubmissionStats(base.address, {
        findingsCount: numberFromSql(stats.findings_count),
        latestFindingAt: stats.latest_finding_at,
      })),
      drift: {
        snapshotsCount: numberFromSql(stats.snapshots_count),
        latestObservedAt: stats.latest_observed_at,
        latestDriftScore: stats.latest_drift_score,
      },
    };
  },
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ address: string }> }) {
  return handleAgentDetail(req, await ctx.params, DEFAULT_DEPS);
}

export function OPTIONS() {
  return optionsResponse();
}

export async function handleAgentDetail(
  _req: NextRequest,
  params: { address: string },
  deps: AgentDetailDeps,
) {
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) return jsonError(400, "invalid_input", "address");
  const row = await deps.getAgent(parsed.data.address);
  if (row === null) return jsonError(404, "not_found", "agent not found");
  return jsonOk({ data: serializeAgentDetail(row) }, { cacheControl: DETAIL_CACHE });
}

function numberFromSql(value: number | string): number {
  return typeof value === "number" ? value : Number.parseInt(value, 10);
}

async function applySubmissionStats(
  address: string,
  stats: { findingsCount: number; latestFindingAt: Date | string | null },
): Promise<{ findingsCount: number; latestFindingAt: Date | string | null }> {
  // Cyber-aware variant: excludes static submissions whose repoFullName
  // is cyber-classified so the v1 detail endpoint doesn't surface
  // hidden activity. (Code audit pass-6, severity medium.)
  const submissions = await loadAgentSubmissionStatsExcludingCyber(address);
  if (submissions.total === 0) return stats;
  return {
    findingsCount: Math.max(stats.findingsCount, submissions.total),
    latestFindingAt: latestDateLike(stats.latestFindingAt, submissions.latestSubmittedAt),
  };
}

function latestDateLike(
  left: Date | string | null,
  right: Date | string | null,
): Date | string | null {
  if (left === null) return right;
  if (right === null) return left;
  return new Date(right) > new Date(left) ? right : left;
}

function sqlRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (typeof result === "object" && result !== null && "rows" in result) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
