import { cache } from "react";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db/index";
import { derivedPublicReceiptCondition } from "@/db/public-receipt";
import { findingDisclosure, findingStatus, outgoingPrs, reviews } from "@/db/schema";
import { isDisclosureGateEnabled } from "@/lib/daybreak-gates-env";
import { nonCyberTierRepoCondition } from "@/lib/cyber-tier";

// Patches-landed + median-time-to-fix headline KPIs. Used by /receipts and /
// hero strips. Two paths union into a per-finding map keyed by findingId:
//
//   in-repo:    finding_status.patchAcceptedAt — Patch Agent suggestion
//               content reached HEAD on an installed-repo default branch.
//   cross-repo: outgoing_prs.status='merged' — AntFleet opened a PR on a
//               repo it doesn't own and the maintainer merged it.
//
// Visibility policy mirrors lib/receipts.ts:publicReceiptGate. In-repo rows
// require publicReceipt=true + !retracted (we know the source review). Cross-
// repo rows pass unless the source is positively known to be private — orphan
// outgoing_prs (no matching finding_status row, typically bench / manual-
// onboarding seeds) count, since they are upstream PRs AntFleet itself
// opened, never private. Orphans contribute to patchesLanded + reposAffected
// + lastUpdated, but not to medianHoursToFix because the posting timestamp
// lives on finding_status which doesn't exist for them.

export type PatchKpis = {
  patchesLanded: number;
  reposAffected: number;
  medianHoursToFix: number | null;
  lastUpdated: Date | null;
};

export const loadPatchKpis = cache(async (): Promise<PatchKpis> => {
  const disclosureGateEnabled = isDisclosureGateEnabled();
  const cyberTierGate = nonCyberTierRepoCondition();
  const findingVisibilityGate = and(
    disclosureGateEnabled ? derivedPublicReceiptCondition : eq(reviews.publicReceipt, true),
    cyberTierGate,
  );
  const inRepoRows = await (disclosureGateEnabled
    ? db
        .select({
          findingId: findingStatus.findingId,
          repoHash: reviews.repoHash,
          postedAt: findingStatus.createdAt,
          resolvedAt: findingStatus.patchAcceptedAt,
        })
        .from(findingStatus)
        .innerJoin(reviews, eq(reviews.reviewId, findingStatus.reviewId))
        .leftJoin(findingDisclosure, eq(findingDisclosure.findingId, findingStatus.findingId))
        .where(
          and(
            findingVisibilityGate,
            sql`${findingStatus.retractedAt} IS NULL`,
            isNotNull(findingStatus.patchAcceptedAt),
          ),
        )
    : db
        .select({
          findingId: findingStatus.findingId,
          repoHash: reviews.repoHash,
          postedAt: findingStatus.createdAt,
          resolvedAt: findingStatus.patchAcceptedAt,
        })
        .from(findingStatus)
        .innerJoin(reviews, eq(reviews.reviewId, findingStatus.reviewId))
        .where(
          and(
            findingVisibilityGate,
            sql`${findingStatus.retractedAt} IS NULL`,
            isNotNull(findingStatus.patchAcceptedAt),
          ),
        ));

  // LEFT JOIN so orphan outgoing_prs (no matching finding_status row) survive
  // the join; filter hides them only if the matched source review is
  // positively known to be private/retracted. Mirrors publicReceiptGate in
  // lib/receipts.ts. Both 'merged' (PR merged) and 'closed_absorbed' (upstream
  // applied an equivalent fix in a separate commit) count — the receipts page
  // and /impact both render both, so the headline KPI must too. resolvedAt
  // coalesces merged_at and closure_detected_at; mapReceiptEligibleRows
  // uses the same priority.
  const crossRepoRows = (await (disclosureGateEnabled
    ? db
        .select({
          findingId: outgoingPrs.sourceFindingId,
          upstreamOwner: outgoingPrs.upstreamOwner,
          upstreamRepo: outgoingPrs.upstreamRepo,
          postedAt: findingStatus.createdAt,
          resolvedAt: sql<Date | string | null>`
            COALESCE(${outgoingPrs.mergedAt}, ${outgoingPrs.closureDetectedAt})
          `.as("resolved_at"),
        })
        .from(outgoingPrs)
        .leftJoin(findingStatus, eq(findingStatus.findingId, outgoingPrs.sourceFindingId))
        .leftJoin(reviews, eq(reviews.reviewId, findingStatus.reviewId))
        .leftJoin(findingDisclosure, eq(findingDisclosure.findingId, findingStatus.findingId))
        .where(
          and(
            inArray(outgoingPrs.status, ["merged", "closed_absorbed"]),
            sql`COALESCE(${outgoingPrs.mergedAt}, ${outgoingPrs.closureDetectedAt}) IS NOT NULL`,
            cyberTierGate,
            sql`(
              ${findingStatus.findingId} IS NULL
              OR (
                ${findingStatus.retractedAt} IS NULL
                AND (
	                  (
	                    ${findingDisclosure.state} = 'published'
	                    AND (
	                      (
	                        ${findingDisclosure.ghsaId} IS NULL
	                        AND ${findingStatus.closureCommentUrl} IS NOT NULL
	                      )
	                      OR (
	                        ${findingDisclosure.ghsaId} IS NOT NULL
	                        AND ${findingDisclosure.ghsaPublishedAt} IS NOT NULL
	                        AND ${findingDisclosure.ghsaHtmlUrl} IS NOT NULL
	                      )
	                    )
	                  )
                  OR (
                    ${findingDisclosure.state} = 'none'
                    AND ${reviews.publicReceipt} = true
                  )
                )
              )
            )`,
          ),
        )
    : db
        .select({
          findingId: outgoingPrs.sourceFindingId,
          upstreamOwner: outgoingPrs.upstreamOwner,
          upstreamRepo: outgoingPrs.upstreamRepo,
          postedAt: findingStatus.createdAt,
          resolvedAt: sql<Date | string | null>`
            COALESCE(${outgoingPrs.mergedAt}, ${outgoingPrs.closureDetectedAt})
          `.as("resolved_at"),
        })
        .from(outgoingPrs)
        .leftJoin(findingStatus, eq(findingStatus.findingId, outgoingPrs.sourceFindingId))
        .leftJoin(reviews, eq(reviews.reviewId, findingStatus.reviewId))
        .where(
          and(
            inArray(outgoingPrs.status, ["merged", "closed_absorbed"]),
            sql`COALESCE(${outgoingPrs.mergedAt}, ${outgoingPrs.closureDetectedAt}) IS NOT NULL`,
            cyberTierGate,
            sql`(
              ${findingStatus.findingId} IS NULL
              OR (
                ${findingStatus.retractedAt} IS NULL
                AND ${reviews.publicReceipt} = true
              )
            )`,
          ),
        ))) as Array<{
    findingId: string;
    upstreamOwner: string;
    upstreamRepo: string;
    postedAt: Date | null;
    resolvedAt: Date | string | null;
  }>;

  // Normalize resolvedAt — neon-serverless returns timestamp expressions as
  // ISO strings, but typed columns come back as Date. The aggregator needs Date.
  const normalizedCrossRepo: CrossRepoLandedRow[] = crossRepoRows.map((r) => ({
    findingId: r.findingId,
    upstreamOwner: r.upstreamOwner,
    upstreamRepo: r.upstreamRepo,
    postedAt: r.postedAt,
    resolvedAt: r.resolvedAt === null ? null : new Date(r.resolvedAt as Date | string),
  }));

  return aggregatePatchKpis(inRepoRows, normalizedCrossRepo);
});

// Pure aggregation so we can unit-test without a DB round-trip.
export type InRepoLandedRow = {
  findingId: string;
  repoHash: string;
  postedAt: Date | null;
  resolvedAt: Date | null;
};

export type CrossRepoLandedRow = {
  findingId: string;
  upstreamOwner: string;
  upstreamRepo: string;
  postedAt: Date | null;
  resolvedAt: Date | null;
};

export function aggregatePatchKpis(
  inRepo: readonly InRepoLandedRow[],
  crossRepo: readonly CrossRepoLandedRow[],
): PatchKpis {
  // landed: rows we count in patchesLanded + reposAffected + lastUpdated.
  // Requires only resolvedAt. Orphan cross-repo rows (postedAt=null) qualify.
  // timed: rows we use for medianHoursToFix. Requires both postedAt + resolvedAt.
  const landedByFinding = new Map<string, { resolvedAt: Date }>();
  const timedByFinding = new Map<string, { postedAt: Date; resolvedAt: Date }>();
  const repos = new Set<string>();
  let lastUpdated: Date | null = null;

  const observe = (
    findingId: string,
    postedAt: Date | null,
    resolvedAt: Date | null,
    repoKey: string,
  ) => {
    if (resolvedAt === null) return;
    repos.add(repoKey);
    if (lastUpdated === null || resolvedAt > lastUpdated) lastUpdated = resolvedAt;
    const prior = landedByFinding.get(findingId);
    if (prior === undefined || resolvedAt < prior.resolvedAt) {
      landedByFinding.set(findingId, { resolvedAt });
    }
    if (postedAt !== null) {
      const priorTimed = timedByFinding.get(findingId);
      if (priorTimed === undefined || resolvedAt < priorTimed.resolvedAt) {
        timedByFinding.set(findingId, { postedAt, resolvedAt });
      }
    }
  };

  for (const r of inRepo) {
    observe(r.findingId, r.postedAt, r.resolvedAt, `repo:${r.repoHash}`);
  }
  for (const r of crossRepo) {
    observe(
      r.findingId,
      r.postedAt,
      r.resolvedAt,
      `upstream:${r.upstreamOwner.toLowerCase()}/${r.upstreamRepo.toLowerCase()}`,
    );
  }

  const hours: number[] = [];
  for (const { postedAt, resolvedAt } of timedByFinding.values()) {
    const diffMs = resolvedAt.getTime() - postedAt.getTime();
    if (diffMs >= 0) hours.push(diffMs / 3_600_000);
  }

  return {
    patchesLanded: landedByFinding.size,
    reposAffected: repos.size,
    medianHoursToFix: hours.length === 0 ? null : median(hours),
    lastUpdated,
  };
}

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// Compact natural-language duration for the hero strip. Rounds down to the
// nearest unit so "47 hours" never reads as "2 days" — half-days are noisy.
export function formatHoursToFix(hours: number): string {
  if (hours < 1) return "<1 hour";
  if (hours < 24) {
    const n = Math.round(hours);
    return `${n} ${n === 1 ? "hour" : "hours"}`;
  }
  const days = hours / 24;
  if (days < 14) {
    const n = Math.round(days);
    return `${n} ${n === 1 ? "day" : "days"}`;
  }
  const weeks = days / 7;
  if (weeks < 9) {
    const n = Math.round(weeks);
    return `${n} ${n === 1 ? "week" : "weeks"}`;
  }
  const months = days / 30;
  const n = Math.round(months);
  return `${n} ${n === 1 ? "month" : "months"}`;
}
