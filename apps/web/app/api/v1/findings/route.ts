import type { NextRequest } from "next/server";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agentFindings } from "@/db/schema";
import { decodeCursor, encodeCursor } from "@/lib/api-v1/cursor";
import { jsonError, jsonOk, LIST_CACHE, optionsResponse } from "@/lib/api-v1/responses";
import { serializeFinding, type FindingRow } from "@/lib/api-v1/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const severitySchema = z.enum(["info", "low", "med", "high"]);
const querySchema = z.object({
  agent_token_address: z.string().min(1).optional(),
  repo_full_name: z.string().min(1).optional(),
  severity: severitySchema.optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

type FindingQuery = z.infer<typeof querySchema>;
type FindingPage = { rows: FindingRow[]; nextCursor: string | null };

export type FindingsDeps = {
  listFindings: (query: FindingQuery, cursor: [string, string] | null) => Promise<FindingPage>;
};

const DEFAULT_DEPS: FindingsDeps = {
  async listFindings(query, cursor) {
    const filters = [sql`${agentFindings.agentTokenAddress} NOT LIKE 'roast:%'`];
    if (query.agent_token_address) {
      filters.push(sql`lower(${agentFindings.agentTokenAddress}) = ${query.agent_token_address.toLowerCase()}`);
    }
    if (query.repo_full_name) {
      filters.push(sql`lower(${agentFindings.repoFullName}) = ${query.repo_full_name.toLowerCase()}`);
    }
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

export async function GET(req: NextRequest) {
  return handleFindings(req, DEFAULT_DEPS);
}

export function OPTIONS() {
  return optionsResponse();
}

export async function handleFindings(req: NextRequest, deps: FindingsDeps) {
  const parsed = parseQuery(req);
  if (!parsed.success) {
    return jsonError(400, "invalid_input", parsed.message);
  }
  const cursor = parseFindingCursor(parsed.query.cursor);
  if (cursor === "invalid") {
    return jsonError(400, "invalid_cursor", "cursor is invalid");
  }
  const page = await deps.listFindings(parsed.query, cursor);
  return jsonOk(
    {
      data: page.rows.map(serializeFinding),
      next_cursor: page.nextCursor,
    },
    { cacheControl: LIST_CACHE },
  );
}

function parseQuery(req: NextRequest):
  | { success: true; query: FindingQuery }
  | { success: false; message: string } {
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (parsed.success) return { success: true, query: parsed.data };
  return { success: false, message: parsed.error.issues[0]?.path.join(".") || "query" };
}

function parseFindingCursor(token: string | undefined): [string, string] | null | "invalid" {
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

export function pageFindings(rows: FindingRow[], limit: number): FindingPage {
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
