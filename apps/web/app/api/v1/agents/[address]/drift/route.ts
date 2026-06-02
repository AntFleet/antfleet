import type { NextRequest } from "next/server";
import { and, asc, desc, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { driftSnapshots } from "@/db/schema";
import { findAgentByAddress } from "@/lib/agent-registry";
import { decodeCursor, encodeCursor } from "@/lib/api-v1/cursor";
import { jsonError, jsonOk, LIST_CACHE, optionsResponse } from "@/lib/api-v1/responses";
import { serializeDriftSnapshot, type DriftRow } from "@/lib/api-v1/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ address: z.string().regex(/^0x[a-fA-F0-9]{40}$/u) });
const querySchema = z.object({
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

type Query = z.infer<typeof querySchema>;
type Page = { rows: DriftRow[]; nextCursor: string | null };

export type AgentDriftDeps = {
  agentExists: (address: string) => Promise<boolean>;
  listDrift: (address: string, query: Query, cursor: [string, string] | null) => Promise<Page>;
};

const DEFAULT_DEPS: AgentDriftDeps = {
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
  async listDrift(address, query, cursor) {
    const filters = [sql`lower(${driftSnapshots.agentTokenAddress}) = ${address.toLowerCase()}`];
    if (query.since) filters.push(gte(driftSnapshots.commitTimestamp, new Date(query.since)));
    if (cursor) {
      filters.push(
        sql`(${driftSnapshots.commitTimestamp} < ${cursor[0]}::timestamptz OR (${driftSnapshots.commitTimestamp} = ${cursor[0]}::timestamptz AND ${driftSnapshots.id} > ${cursor[1]}))`,
      );
    }
    const rows = await db
      .select()
      .from(driftSnapshots)
      .where(and(...filters))
      .orderBy(desc(driftSnapshots.commitTimestamp), asc(driftSnapshots.id))
      .limit(query.limit + 1);
    return pageDrift(rows, query.limit);
  },
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ address: string }> }) {
  return handleAgentDrift(req, await ctx.params, DEFAULT_DEPS);
}

export function OPTIONS() {
  return optionsResponse();
}

export async function handleAgentDrift(
  req: NextRequest,
  params: { address: string },
  deps: AgentDriftDeps,
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
  const page = await deps.listDrift(parsedParams.data.address, parsedQuery.data, cursor);
  return jsonOk(
    { data: page.rows.map(serializeDriftSnapshot), next_cursor: page.nextCursor },
    { cacheControl: LIST_CACHE },
  );
}

function parseCursor(token: string | undefined): [string, string] | null | "invalid" {
  if (!token) return null;
  const decoded = decodeCursor(token, 2);
  if (
    decoded === null ||
    typeof decoded[0] !== "string" ||
    Number.isNaN(Date.parse(decoded[0])) ||
    typeof decoded[1] !== "string"
  ) {
    return "invalid";
  }
  return [decoded[0], decoded[1]];
}

export function pageDrift(rows: DriftRow[], limit: number): Page {
  const data = rows.slice(0, limit);
  const last = data[data.length - 1];
  return {
    rows: data,
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor([cursorTimestamp(last.commitTimestamp), last.id])
        : null,
  };
}

function cursorTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function sqlRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (typeof result === "object" && result !== null && "rows" in result) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
