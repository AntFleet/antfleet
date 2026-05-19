import type { NextRequest } from "next/server";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agentFindings } from "@/db/schema";
import { findAgentByAddress } from "@/lib/agent-registry";
import { decodeCursor, encodeCursor } from "@/lib/api-v1/cursor";
import { jsonError, jsonOk, LIST_CACHE, optionsResponse } from "@/lib/api-v1/responses";
import { serializeFinding, type FindingRow } from "@/lib/api-v1/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ address: z.string().regex(/^0x[a-fA-F0-9]{40}$/u) });
const querySchema = z.object({
  severity: z.enum(["info", "low", "med", "high"]).optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

type Query = z.infer<typeof querySchema>;
type Page = { rows: FindingRow[]; nextCursor: string | null };

export type AgentFindingsDeps = {
  agentExists: (address: string) => Promise<boolean>;
  listFindings: (address: string, query: Query, cursor: [string, string] | null) => Promise<Page>;
};

const DEFAULT_DEPS: AgentFindingsDeps = {
  async agentExists(address) {
    if (findAgentByAddress(address) !== null) return true;
    const result = await db.execute(sql`
      SELECT token_address FROM factory_launches
      WHERE lower(token_address) = ${address.toLowerCase()}
        AND prelaunch_status = 'published'
      LIMIT 1
    `);
    return sqlRows<unknown>(result).length > 0;
  },
  async listFindings(address, query, cursor) {
    const filters = [
      sql`lower(${agentFindings.agentTokenAddress}) = ${address.toLowerCase()}`,
      sql`${agentFindings.agentTokenAddress} NOT LIKE 'roast:%'`,
    ];
    if (query.severity) filters.push(eq(agentFindings.severity, query.severity));
    if (query.since) filters.push(gte(agentFindings.publishedAt, new Date(query.since)));
    if (cursor) {
      const cursorDate = new Date(cursor[0]);
      filters.push(
        sql`(${agentFindings.publishedAt} < ${cursorDate} OR (${agentFindings.publishedAt} = ${cursorDate} AND ${agentFindings.findingId} > ${cursor[1]}))`,
      );
    }
    const rows = await db
      .select()
      .from(agentFindings)
      .where(and(...filters))
      .orderBy(desc(agentFindings.publishedAt), asc(agentFindings.findingId))
      .limit(query.limit + 1);
    return pageFindings(rows, query.limit);
  },
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ address: string }> }) {
  return handleAgentFindings(req, await ctx.params, DEFAULT_DEPS);
}

export function OPTIONS() {
  return optionsResponse();
}

export async function handleAgentFindings(
  req: NextRequest,
  params: { address: string },
  deps: AgentFindingsDeps,
) {
  const parsedParams = paramsSchema.safeParse(params);
  if (!parsedParams.success) return jsonError(400, "invalid_input", "address");
  const parsedQuery = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsedQuery.success) {
    return jsonError(400, "invalid_input", parsedQuery.error.issues[0]?.path.join(".") || "query");
  }
  const cursor = parseCursor(parsedQuery.data.cursor);
  if (cursor === "invalid") return jsonError(400, "invalid_cursor", "cursor is invalid");
  if (!(await deps.agentExists(parsedParams.data.address))) {
    return jsonError(404, "not_found", "agent not found");
  }
  const page = await deps.listFindings(parsedParams.data.address, parsedQuery.data, cursor);
  return jsonOk(
    { data: page.rows.map(serializeFinding), next_cursor: page.nextCursor },
    { cacheControl: LIST_CACHE },
  );
}

function parseCursor(token: string | undefined): [string, string] | null | "invalid" {
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

function pageFindings(rows: FindingRow[], limit: number): Page {
  const data = rows.slice(0, limit);
  const last = data[data.length - 1];
  return {
    rows: data,
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor([serializeFinding(last).published_at, last.findingId])
        : null,
  };
}

function sqlRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (typeof result === "object" && result !== null && "rows" in result) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
