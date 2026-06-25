// Read-side helpers for the repo cyber tier (migration 0048).
//
// All visibility / disclosure / prompt-routing call sites READ tier
// through these helpers — they MUST NOT touch repo_tier directly. That
// keeps the flag gate (ANTFLEET_CYBER_TIER) the single switch: when OFF
// every read returns 'default' regardless of stored value, so behavior
// is byte-identical to today.
//
// Writes live in lib/cyber-tier-admin.ts (operator-only). This file
// intentionally does NOT re-export them — defense in depth so a
// webhook/install-flow refactor cannot accidentally pick up the setter
// via the read-helper module.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { repoTier, reviews, type CyberTier } from "@/db/schema";
import { isCyberTierEnabled } from "./daybreak-gates-env";

export type { CyberTier };

function normalizeKey(owner: string, repo: string): { ownerLc: string; repoLc: string } {
  return { ownerLc: owner.toLowerCase(), repoLc: repo.toLowerCase() };
}

// Returns the stored tier for the repo. Returns 'default' both when the
// flag is OFF (regardless of stored value) and when no row exists.
export async function getRepoCyberTier(owner: string, repo: string): Promise<CyberTier> {
  if (!isCyberTierEnabled()) return "default";
  const { ownerLc, repoLc } = normalizeKey(owner, repo);
  const rows = await db
    .select({ tier: repoTier.tier })
    .from(repoTier)
    .where(and(eq(repoTier.ownerLc, ownerLc), eq(repoTier.repoLc, repoLc)))
    .limit(1);
  return rows[0]?.tier ?? "default";
}

// Convenience boolean form for the common branch. False whenever the
// flag is OFF.
export async function isCyberTierRepo(owner: string, repo: string): Promise<boolean> {
  return (await getRepoCyberTier(owner, repo)) === "cyber";
}

// SQL fragment for use in the existing visibility filters (anatomy.ts,
// kpis.ts, scorecard.ts, receipts.ts, sitemap.ts, disagreements/[id]).
// When the flag is OFF the fragment collapses to `true` so callers can
// always `and(existingFilter, nonCyberTierRepoCondition())` without a
// conditional branch at every site.
//
// The fragment assumes the caller joins from `reviews` (the standard
// shape for these gates). For non-reviews-joined queries the caller
// passes owner+repo expressions explicitly via
// nonCyberTierRepoConditionFor().
export function nonCyberTierRepoCondition() {
  if (!isCyberTierEnabled()) return sql<boolean>`true`;
  return sql<boolean>`NOT EXISTS (
    SELECT 1 FROM repo_tier
    WHERE owner_lc = lower(${reviews.owner})
      AND repo_lc = lower(${reviews.repo})
      AND tier = 'cyber'
  )`;
}

export function nonCyberTierRepoConditionFor(
  ownerExpr: ReturnType<typeof sql>,
  repoExpr: ReturnType<typeof sql>,
) {
  if (!isCyberTierEnabled()) return sql<boolean>`true`;
  return sql<boolean>`NOT EXISTS (
    SELECT 1 FROM repo_tier
    WHERE owner_lc = lower(${ownerExpr})
      AND repo_lc = lower(${repoExpr})
      AND tier = 'cyber'
  )`;
}

// Raw-SQL exclusion fragment for injection into hand-written SQL CTEs
// where Drizzle's typed predicates aren't available (e.g. the
// hand-rolled CTEs in /api/v1/agents, /api/v1/agents/[address],
// /api/v1/stats, /api/v1/agents/[address]/findings agentExists).
// Caller is responsible for placing it inside a WHERE/AND context — the
// fragment starts with `AND`. When the flag is OFF the fragment is the
// empty SQL ` ` so behavior is byte-identical to pre-cyber-tier.
//
// Pass the full-name column reference as a sql`...` template so it's
// composable with the parent query's binding state.
//
// Note on index usage: the WHERE clause uses `split_part` against the
// repo_tier PRIMARY KEY columns (owner_lc, repo_lc) so the planner can
// probe the PK index instead of falling back to a sequential scan. The
// earlier `owner_lc || '/' || repo_lc = lower(fullName)` form was
// non-sargable and forced a full repo_tier scan per row of the outer
// query. (Architect audit pass-5, severity medium, runtime-cost.)
export function rawCyberTierExclusionForFullName(fullNameSql: ReturnType<typeof sql>) {
  if (!isCyberTierEnabled()) return sql``;
  return sql`AND NOT EXISTS (
    SELECT 1 FROM repo_tier
    WHERE owner_lc = split_part(lower(${fullNameSql}), '/', 1)
      AND repo_lc = split_part(lower(${fullNameSql}), '/', 2)
      AND tier = 'cyber'
  )`;
}

// Batched lookup: returns the SET of repo_full_name values (lowercased)
// that are classified `cyber`. Used by callers that filter static
// in-process data (e.g. AGENT_SUBMISSIONS) where the SQL helpers don't
// apply. ONE repo_tier query per request instead of N (per submission).
// (Architect audit pass-7, severity medium, n+1 lookups.)
//
// When ANTFLEET_CYBER_TIER is OFF the helper returns an empty Set
// without hitting the DB — every read is "not cyber".
export async function loadCyberTierFullNameSet(fullNames: readonly string[]): Promise<Set<string>> {
  if (!isCyberTierEnabled() || fullNames.length === 0) return new Set();
  // Normalize + dedupe before the query so the IN list is minimal.
  const normalized = Array.from(
    new Set(fullNames.map((n) => n.toLowerCase()).filter((n) => n.length > 0)),
  );
  if (normalized.length === 0) return new Set();
  const rows = await db
    .select({ ownerLc: repoTier.ownerLc, repoLc: repoTier.repoLc })
    .from(repoTier)
    .where(
      and(
        eq(repoTier.tier, "cyber"),
        sql`(${repoTier.ownerLc} || '/' || ${repoTier.repoLc}) = ANY(${normalized})`,
      ),
    );
  return new Set(rows.map((r) => `${r.ownerLc}/${r.repoLc}`));
}

// Variant for tables that store the repo as a single "owner/repo" string
// (e.g. agent_findings.repo_full_name). Joins repo_tier on the
// lowercased composite. Rows with NULL full name pass through (no cyber
// match possible). When the flag is OFF the fragment collapses to
// `true` and behavior is byte-identical to pre-cyber-tier.
//
// Used by:
//   - apps/web/db/queries.ts loadAgentDetail (agent_findings query)
//   - apps/web/app/api/v1/findings/route.ts
//   - apps/web/app/api/v1/findings/[finding_id]/route.ts
//   - apps/web/app/api/v1/agents/[address]/findings/route.ts
export function nonCyberTierRepoConditionForFullName(fullNameExpr: ReturnType<typeof sql>) {
  if (!isCyberTierEnabled()) return sql<boolean>`true`;
  // PK-sargable form (see rawCyberTierExclusionForFullName comment).
  return sql<boolean>`(
    ${fullNameExpr} IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM repo_tier
      WHERE owner_lc = split_part(lower(${fullNameExpr}), '/', 1)
        AND repo_lc = split_part(lower(${fullNameExpr}), '/', 2)
        AND tier = 'cyber'
    )
  )`;
}
