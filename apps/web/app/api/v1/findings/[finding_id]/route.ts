import type { NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agentFindings } from "@/db/schema";
import { DETAIL_CACHE, jsonError, jsonOk, optionsResponse } from "@/lib/api-v1/responses";
import { serializeFinding, type FindingRow } from "@/lib/api-v1/serialize";
import { nonCyberTierRepoConditionForFullName } from "@/lib/cyber-tier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ finding_id: z.string().min(1) });

export type FindingDetailDeps = {
  getFinding: (findingId: string) => Promise<FindingRow | null>;
};

const DEFAULT_DEPS: FindingDetailDeps = {
  async getFinding(findingId) {
    if (findingId.toLowerCase().startsWith("roast:")) return null;
    // Cyber-tier exclusion: direct finding-id lookups must also 404 for
    // cyber-classified repos. (Code + security audit pass-1, high.)
    const rows = await db
      .select()
      .from(agentFindings)
      .where(
        and(
          eq(agentFindings.findingId, findingId),
          sql`${agentFindings.agentTokenAddress} NOT LIKE 'roast:%'`,
          nonCyberTierRepoConditionForFullName(sql`${agentFindings.repoFullName}`),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ finding_id: string }> }) {
  return handleFindingDetail(req, await ctx.params, DEFAULT_DEPS);
}

export function OPTIONS() {
  return optionsResponse();
}

export async function handleFindingDetail(
  _req: NextRequest,
  params: { finding_id: string },
  deps: FindingDetailDeps,
) {
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) return jsonError(400, "invalid_input", "finding_id");
  const row = await deps.getFinding(parsed.data.finding_id);
  if (row === null) return jsonError(404, "not_found", "finding not found");
  return jsonOk({ data: serializeFinding(row) }, { cacheControl: DETAIL_CACHE });
}
