import type { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { AUTONOMOPOLY_AGENT } from "@/lib/agent-registry";
import { decodeCursor, encodeCursor } from "@/lib/api-v1/cursor";
import { jsonError, jsonOk, LIST_CACHE, optionsResponse } from "@/lib/api-v1/responses";
import { iso, serializeAgent, type AgentListRow } from "@/lib/api-v1/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

type AgentQuery = z.infer<typeof querySchema>;
type AgentCursor = [string, string];
type AgentPage = { rows: AgentListRow[]; nextCursor: string | null };
type SqlAgentRow = {
  address: string;
  name: string;
  repo_full_name: string | null;
  source: "registry" | "factory";
  first_seen_at: Date | string;
  findings_count: number | string;
  latest_finding_at: Date | string | null;
};

export type AgentsDeps = {
  listAgents: (query: AgentQuery, cursor: AgentCursor | null) => Promise<AgentPage>;
};

const DEFAULT_DEPS: AgentsDeps = {
  async listAgents(query, cursor) {
    const result = await db.execute(sql`
      WITH directory AS (
        SELECT
          ${AUTONOMOPOLY_AGENT.address}::text AS address,
          ${AUTONOMOPOLY_AGENT.name}::text AS name,
          ${AUTONOMOPOLY_AGENT.repo}::text AS repo_full_name,
          'registry'::text AS source,
          '2026-05-19T00:00:00.000Z'::timestamptz AS first_seen_at
        UNION ALL
        SELECT
          token_address AS address,
          coalesce(token_name, token_symbol, token_address) AS name,
          repo_full_name,
          'factory'::text AS source,
          deployed_at AS first_seen_at
        FROM factory_launches
        WHERE prelaunch_status = 'published'
      )
      SELECT
        directory.address,
        directory.name,
        directory.repo_full_name,
        directory.source,
        directory.first_seen_at,
        count(agent_findings.finding_id)::int AS findings_count,
        max(agent_findings.published_at) AS latest_finding_at
      FROM directory
      LEFT JOIN agent_findings
        ON lower(agent_findings.agent_token_address) = lower(directory.address)
        AND agent_findings.agent_token_address NOT LIKE 'roast:%'
      WHERE ${
        cursor === null
          ? sql`true`
          : sql`(directory.first_seen_at < ${new Date(cursor[0])} OR (directory.first_seen_at = ${new Date(cursor[0])} AND directory.address > ${cursor[1]}))`
      }
      GROUP BY directory.address, directory.name, directory.repo_full_name, directory.source, directory.first_seen_at
      ORDER BY directory.first_seen_at DESC, directory.address ASC
      LIMIT ${query.limit + 1}
    `);
    return pageAgents(sqlRows<SqlAgentRow>(result).map(agentRowFromSql), query.limit);
  },
};

export async function GET(req: NextRequest) {
  return handleAgents(req, DEFAULT_DEPS);
}

export function OPTIONS() {
  return optionsResponse();
}

export async function handleAgents(req: NextRequest, deps: AgentsDeps) {
  const parsed = parseQuery(req);
  if (!parsed.success) return jsonError(400, "invalid_input", parsed.message);
  const cursor = parseAgentCursor(parsed.query.cursor);
  if (cursor === "invalid") return jsonError(400, "invalid_cursor", "cursor is invalid");
  const page = await deps.listAgents(parsed.query, cursor);
  return jsonOk(
    { data: page.rows.map(serializeAgent), next_cursor: page.nextCursor },
    { cacheControl: LIST_CACHE },
  );
}

function parseQuery(
  req: NextRequest,
): { success: true; query: AgentQuery } | { success: false; message: string } {
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (parsed.success) return { success: true, query: parsed.data };
  return { success: false, message: parsed.error.issues[0]?.path.join(".") || "query" };
}

function parseAgentCursor(token: string | undefined): AgentCursor | null | "invalid" {
  if (!token) return null;
  const decoded = decodeCursor(token, 2);
  if (
    decoded === null ||
    typeof decoded[0] !== "string" ||
    Number.isNaN(new Date(decoded[0]).getTime()) ||
    typeof decoded[1] !== "string"
  ) {
    return "invalid";
  }
  return [decoded[0], decoded[1]];
}

export function pageAgents(rows: AgentListRow[], limit: number): AgentPage {
  const data = rows.slice(0, limit);
  const last = data[data.length - 1];
  return {
    rows: data,
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor([iso(last.firstSeenAt), last.address])
        : null,
  };
}

function agentRowFromSql(row: SqlAgentRow): AgentListRow {
  return {
    address: row.address,
    name: row.name,
    repoFullName: row.repo_full_name,
    source: row.source,
    firstSeenAt: row.first_seen_at,
    findingsCount:
      typeof row.findings_count === "number"
        ? row.findings_count
        : Number.parseInt(row.findings_count, 10),
    latestFindingAt: row.latest_finding_at,
  };
}

function sqlRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (typeof result === "object" && result !== null && "rows" in result) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
