import { cache } from "react";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/db/index";
import { reviewDerivedPublicReceiptCondition } from "@/db/public-receipt";
import { reviews, findingStatus } from "@/db/schema";
import { isDisclosureGateEnabled } from "@/lib/daybreak-gates-env";
import { nonCyberTierRepoCondition } from "@/lib/cyber-tier";

export const GENERATOR_VERSION = "1.0.0";

function reviewPublicGate() {
  return and(
    isDisclosureGateEnabled()
      ? reviewDerivedPublicReceiptCondition
      : eq(reviews.publicReceipt, true),
    nonCyberTierRepoCondition(),
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderStats = {
  avgFindingsPerPR: number;
  medianWallTimeSeconds: number;
  avgCostUsd: number | null;
  patchProposalRate: number;
  topCategories: Array<{ category: string; count: number }>;
};

export type ScorecardPayload = {
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  generatorVersion: string;
  sample: {
    reviewsAnalyzed: number;
    findingsPosted: number;
    publicReceiptOnly: true;
  };
  perProvider: {
    anthropic: ProviderStats;
    openai: ProviderStats;
  };
  agreement: {
    rate: number;
    bothProposedPatches: number;
    opusOnlyFindings: number;
    gpt5OnlyFindings: number;
  };
  rolling4Week: {
    bothProposedRate: number | null;
    avgFindingsPerPRAnthropic: number | null;
    avgFindingsPerPROpenai: number | null;
    medianWallTimeAnthropic: number | null;
    medianWallTimeOpenai: number | null;
  };
};

// ---------------------------------------------------------------------------
// Internal types for parsed provider data
// ---------------------------------------------------------------------------

type PerProviderEntry = {
  name: string;
  ms: number;
  output: { findings: Array<{ category?: string }> } | null;
};

type ReviewRow = {
  reviewId: string;
  providerResponses: unknown;
  costEstimatedUsd: string;
};

type FindingRow = {
  reviewId: string;
  suggestedPatchOpus: string | null;
  suggestedPatchGpt5: string | null;
};

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Return the previous Sunday (inclusive) as YYYY-MM-DD for a given date. */
export function weekEndingSunday(d: Date): string {
  const copy = new Date(d);
  copy.setUTCHours(0, 0, 0, 0);
  const dow = copy.getUTCDay(); // 0=Sun
  if (dow !== 0) {
    copy.setUTCDate(copy.getUTCDate() - dow);
  }
  return copy.toISOString().slice(0, 10);
}

/** Parse YYYY-MM-DD and verify it's a valid Sunday. Returns null on bad input. */
export function parseWeekEndingDate(dateStr: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const d = new Date(dateStr + "T00:00:00Z");
  if (isNaN(d.getTime())) return null;
  // Verify the parsed date round-trips (catches 2026-02-30 etc.)
  if (d.toISOString().slice(0, 10) !== dateStr) return null;
  // Must be a Sunday
  if (d.getUTCDay() !== 0) return null;
  return d;
}

/** Compute the Monday that starts the week ending on the given Sunday. */
function weekStartMonday(sundayDate: Date): Date {
  const d = new Date(sundayDate);
  d.setUTCDate(d.getUTCDate() - 6);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

export async function computeScorecardForWeek(weekEndingDate: Date): Promise<ScorecardPayload> {
  const weekStart = weekStartMonday(weekEndingDate);
  const weekEndExclusive = new Date(weekEndingDate);
  weekEndExclusive.setUTCDate(weekEndExclusive.getUTCDate() + 1);
  weekEndExclusive.setUTCHours(0, 0, 0, 0);

  // Fetch public-receipt reviews in the date window
  const reviewRows = await db
    .select({
      reviewId: reviews.reviewId,
      providerResponses: reviews.providerResponses,
      costEstimatedUsd: reviews.costEstimatedUsd,
    })
    .from(reviews)
    .where(
      and(
        reviewPublicGate(),
        gte(reviews.createdAt, weekStart),
        lt(reviews.createdAt, weekEndExclusive),
      ),
    );

  // Fetch finding_status rows for those reviews
  const reviewIds = reviewRows.map((r) => r.reviewId);
  const findingRows: FindingRow[] =
    reviewIds.length > 0
      ? await db
          .select({
            reviewId: findingStatus.reviewId,
            suggestedPatchOpus: findingStatus.suggestedPatchOpus,
            suggestedPatchGpt5: findingStatus.suggestedPatchGpt5,
          })
          .from(findingStatus)
          .where(
            and(inArray(findingStatus.reviewId, reviewIds), eq(findingStatus.source, "consensus")),
          )
      : [];

  const payload = aggregatePayload(reviewRows, findingRows, weekStart, weekEndingDate);

  // Compute rolling 4-week averages
  const rolling = await computeRolling4Week(weekEndingDate);
  payload.rolling4Week = rolling;

  return payload;
}

// ---------------------------------------------------------------------------
// Pure aggregation (testable without DB)
// ---------------------------------------------------------------------------

export function aggregatePayload(
  reviewRows: ReviewRow[],
  findingRows: FindingRow[],
  weekStart: Date,
  weekEnd: Date,
): ScorecardPayload {
  const now = new Date();

  // Parse provider entries from each review
  const anthropicTimes: number[] = [];
  const openaiTimes: number[] = [];
  const anthropicCategories: Map<string, number> = new Map();
  const openaiCategories: Map<string, number> = new Map();
  let anthropicTotalFindings = 0;
  let openaiTotalFindings = 0;
  let totalCostUsd = 0;
  let costCount = 0;

  for (const row of reviewRows) {
    const entries = parsePerProvider(row.providerResponses);
    for (const entry of entries) {
      if (entry.name === "anthropic") {
        anthropicTimes.push(entry.ms / 1000);
        const findings = entry.output?.findings ?? [];
        anthropicTotalFindings += findings.length;
        for (const f of findings) {
          const cat = f.category ?? "unknown";
          anthropicCategories.set(cat, (anthropicCategories.get(cat) ?? 0) + 1);
        }
      } else if (entry.name === "openai") {
        openaiTimes.push(entry.ms / 1000);
        const findings = entry.output?.findings ?? [];
        openaiTotalFindings += findings.length;
        for (const f of findings) {
          const cat = f.category ?? "unknown";
          openaiCategories.set(cat, (openaiCategories.get(cat) ?? 0) + 1);
        }
      }
    }
    const cost = parseFloat(row.costEstimatedUsd);
    if (!isNaN(cost) && cost > 0) {
      totalCostUsd += cost;
      costCount += 1;
    }
  }

  const reviewCount = reviewRows.length;
  const findingsPosted = findingRows.length;

  // Agreement stats
  let bothProposed = 0;
  let opusOnly = 0;
  let gpt5Only = 0;
  for (const f of findingRows) {
    const hasOpus = f.suggestedPatchOpus !== null;
    const hasGpt5 = f.suggestedPatchGpt5 !== null;
    if (hasOpus && hasGpt5) bothProposed++;
    else if (hasOpus) opusOnly++;
    else if (hasGpt5) gpt5Only++;
  }

  const totalDistinctFindings = anthropicTotalFindings + openaiTotalFindings;
  const agreementRate =
    totalDistinctFindings > 0 ? round(findingsPosted / totalDistinctFindings, 4) : 0;

  return {
    weekStart: weekStart.toISOString().slice(0, 10),
    weekEnd: weekEnd.toISOString().slice(0, 10),
    generatedAt: now.toISOString(),
    generatorVersion: GENERATOR_VERSION,
    sample: {
      reviewsAnalyzed: reviewCount,
      findingsPosted,
      publicReceiptOnly: true,
    },
    perProvider: {
      anthropic: {
        avgFindingsPerPR: reviewCount > 0 ? round(anthropicTotalFindings / reviewCount, 2) : 0,
        medianWallTimeSeconds: median(anthropicTimes),
        avgCostUsd: costCount > 0 ? round(totalCostUsd / costCount, 4) : null,
        patchProposalRate:
          anthropicTotalFindings > 0 && findingsPosted > 0
            ? round((bothProposed + opusOnly) / findingsPosted, 4)
            : 0,
        topCategories: topN(anthropicCategories, 3),
      },
      openai: {
        avgFindingsPerPR: reviewCount > 0 ? round(openaiTotalFindings / reviewCount, 2) : 0,
        medianWallTimeSeconds: median(openaiTimes),
        avgCostUsd: costCount > 0 ? round(totalCostUsd / costCount, 4) : null,
        patchProposalRate:
          openaiTotalFindings > 0 && findingsPosted > 0
            ? round((bothProposed + gpt5Only) / findingsPosted, 4)
            : 0,
        topCategories: topN(openaiCategories, 3),
      },
    },
    agreement: {
      rate: agreementRate,
      bothProposedPatches: bothProposed,
      opusOnlyFindings: opusOnly,
      gpt5OnlyFindings: gpt5Only,
    },
    rolling4Week: {
      bothProposedRate: null,
      avgFindingsPerPRAnthropic: null,
      avgFindingsPerPROpenai: null,
      medianWallTimeAnthropic: null,
      medianWallTimeOpenai: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Rolling 4-week computation
// ---------------------------------------------------------------------------

async function computeRolling4Week(
  weekEndingDate: Date,
): Promise<ScorecardPayload["rolling4Week"]> {
  // Go back 4 weeks from the current week's start
  const fourWeeksStart = new Date(weekEndingDate);
  fourWeeksStart.setUTCDate(fourWeeksStart.getUTCDate() - 27); // 4 weeks = 28 days, start on Monday
  fourWeeksStart.setUTCHours(0, 0, 0, 0);

  const weekEndExclusive = new Date(weekEndingDate);
  weekEndExclusive.setUTCDate(weekEndExclusive.getUTCDate() + 1);
  weekEndExclusive.setUTCHours(0, 0, 0, 0);

  const rollingReviews = await db
    .select({
      reviewId: reviews.reviewId,
      providerResponses: reviews.providerResponses,
    })
    .from(reviews)
    .where(
      and(
        reviewPublicGate(),
        gte(reviews.createdAt, fourWeeksStart),
        lt(reviews.createdAt, weekEndExclusive),
      ),
    );

  if (rollingReviews.length === 0) {
    return {
      bothProposedRate: null,
      avgFindingsPerPRAnthropic: null,
      avgFindingsPerPROpenai: null,
      medianWallTimeAnthropic: null,
      medianWallTimeOpenai: null,
    };
  }

  const rollingReviewIds = rollingReviews.map((r) => r.reviewId);
  const rollingFindings: FindingRow[] = await db
    .select({
      reviewId: findingStatus.reviewId,
      suggestedPatchOpus: findingStatus.suggestedPatchOpus,
      suggestedPatchGpt5: findingStatus.suggestedPatchGpt5,
    })
    .from(findingStatus)
    .where(
      and(inArray(findingStatus.reviewId, rollingReviewIds), eq(findingStatus.source, "consensus")),
    );

  const anthropicTimes: number[] = [];
  const openaiTimes: number[] = [];
  let anthropicFindings = 0;
  let openaiFindings = 0;
  let bothProposed = 0;

  for (const row of rollingReviews) {
    const entries = parsePerProvider(row.providerResponses);
    for (const entry of entries) {
      if (entry.name === "anthropic") {
        anthropicTimes.push(entry.ms / 1000);
        anthropicFindings += entry.output?.findings?.length ?? 0;
      } else if (entry.name === "openai") {
        openaiTimes.push(entry.ms / 1000);
        openaiFindings += entry.output?.findings?.length ?? 0;
      }
    }
  }

  for (const f of rollingFindings) {
    if (f.suggestedPatchOpus !== null && f.suggestedPatchGpt5 !== null) bothProposed++;
  }

  const reviewCount = rollingReviews.length;
  const totalFindings = rollingFindings.length;

  return {
    bothProposedRate: totalFindings > 0 ? round(bothProposed / totalFindings, 4) : null,
    avgFindingsPerPRAnthropic: reviewCount > 0 ? round(anthropicFindings / reviewCount, 2) : null,
    avgFindingsPerPROpenai: reviewCount > 0 ? round(openaiFindings / reviewCount, 2) : null,
    medianWallTimeAnthropic: anthropicTimes.length > 0 ? median(anthropicTimes) : null,
    medianWallTimeOpenai: openaiTimes.length > 0 ? median(openaiTimes) : null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// All-time rollup of the same definition the weekly snapshot uses:
//   rate = findingsPosted / (anthropicTotalFindings + openaiTotalFindings)
// where findingsPosted is the count of unanimous (posted) findings and the
// denominator is the sum of independent finding counts each model produced
// across all reviews. Cache()-wrapped so /impact, /scorecard, /activity share
// one query when the StatsStrip renders.
export type AllTimeAgreement = {
  rate: number;
  findingsPosted: number;
  totalDistinctFindings: number;
};

export const loadAllTimeAgreementRate = cache(async (): Promise<AllTimeAgreement | null> => {
  const reviewRows = await db
    .select({
      reviewId: reviews.reviewId,
      providerResponses: reviews.providerResponses,
    })
    .from(reviews)
    .where(reviewPublicGate());

  if (reviewRows.length === 0) return null;

  const reviewIds = reviewRows.map((r) => r.reviewId);
  const findingRows = await db
    .select({ reviewId: findingStatus.reviewId })
    .from(findingStatus)
    .where(and(inArray(findingStatus.reviewId, reviewIds), eq(findingStatus.source, "consensus")));

  let denominator = 0;
  for (const row of reviewRows) {
    for (const entry of parsePerProvider(row.providerResponses)) {
      if (entry.name === "anthropic" || entry.name === "openai") {
        denominator += entry.output?.findings.length ?? 0;
      }
    }
  }

  const findingsPosted = findingRows.length;
  if (denominator === 0) return null;
  return {
    rate: findingsPosted / denominator,
    findingsPosted,
    totalDistinctFindings: denominator,
  };
});

function parsePerProvider(providerResponses: unknown): PerProviderEntry[] {
  if (typeof providerResponses !== "object" || providerResponses === null) return [];
  const pr = providerResponses as Record<string, unknown>;
  if (pr["status"] === "skipped") return [];
  const perProvider = pr["perProvider"];
  if (!Array.isArray(perProvider)) return [];
  const result: PerProviderEntry[] = [];
  for (const entry of perProvider) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const name = e["name"];
    const ms = e["ms"];
    if (typeof name !== "string" || typeof ms !== "number") continue;
    const rawOutput = e["output"];
    const output: PerProviderEntry["output"] =
      typeof rawOutput === "object" &&
      rawOutput !== null &&
      Array.isArray((rawOutput as Record<string, unknown>)["findings"])
        ? (rawOutput as PerProviderEntry["output"])
        : null;
    result.push({ name, ms, output });
  }
  return result;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? round(sorted[mid], 2)
    : round((sorted[mid - 1] + sorted[mid]) / 2, 2);
}

function topN(map: Map<string, number>, n: number): Array<{ category: string; count: number }> {
  return [...map.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([category, count]) => ({ category, count }));
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
