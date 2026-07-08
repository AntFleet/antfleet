import { and, inArray, sql } from "drizzle-orm";
import { db } from "@/db/index";
import type { PublicReceiptDetailRow, PublicReceiptRow } from "@/db/queries";
import {
  findingDisclosure,
  findingStatus,
  outgoingPrs,
  reviews,
  type OutgoingPr,
} from "@/db/schema";
import { isCyberTierEnabled, isDisclosureGateEnabled } from "@/lib/daybreak-gates-env";
import { shortenRepoHash, shortenReviewId, shortenSha } from "./short-id";

// Pure view-model for the public /receipts page. Lives apart from the DB
// query so the adapter (privacy labels + relative time) can be unit-tested
// without a database round-trip. The receipt URL is preserved as-is — it
// IS the receipt artifact per §18.2 and §15; without the link, the page
// is just numbers we could have made up.
export type DisplayReceipt = {
  findingId: string;
  severity: string;
  label: string | null;
  category: string;
  title: string;
  repoLabel: string;
  prLabel: string;
  shaLabel: string | null;
  relativeClosedAt: string | null;
  // ISO 8601, kept so the page can build the next-page cursor link from the
  // last visible row without re-querying. Null only when closure_detected_at
  // is null (pre-closure row that snuck into the result set — defensive,
  // shouldn't happen because the query filters status='closed').
  closedAtIso: string | null;
  receiptUrl: string | null;
};

export function toDisplayReceipt(row: PublicReceiptRow, now: Date): DisplayReceipt {
  return {
    findingId: row.findingId,
    severity: row.severity,
    label: row.label,
    category: row.category,
    title: row.title,
    repoLabel: `repo ${shortenRepoHash(row.repoHash)}`,
    prLabel: `PR #${row.prNumber}`,
    shaLabel: row.closureSha === null ? null : shortenSha(row.closureSha),
    relativeClosedAt: row.closedAt === null ? null : formatRelativeTime(now, row.closedAt),
    closedAtIso: row.closedAt === null ? null : row.closedAt.toISOString(),
    receiptUrl: row.closureCommentUrl ?? row.ghsaHtmlUrl,
  };
}

// "just now" / "3 minutes ago" / "5 hours ago" / "2 days ago" / "3 weeks ago"
// / "4 months ago" / "1 year ago". No fractions; rounds toward zero. Future
// dates are clamped to "just now" — the receipts page shows closures that
// already happened, so a future stamp is data-integrity noise we shouldn't
// surface to the public page.
export function formatRelativeTime(now: Date, then: Date): string {
  const deltaMs = now.getTime() - then.getTime();
  if (deltaMs < 0) return "just now";

  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const MONTH = 30 * DAY;
  const YEAR = 365 * DAY;

  if (deltaMs < MINUTE) return "just now";
  if (deltaMs < HOUR) return plural(Math.floor(deltaMs / MINUTE), "minute");
  if (deltaMs < DAY) return plural(Math.floor(deltaMs / HOUR), "hour");
  if (deltaMs < WEEK) return plural(Math.floor(deltaMs / DAY), "day");
  if (deltaMs < MONTH) return plural(Math.floor(deltaMs / WEEK), "week");
  if (deltaMs < YEAR) return plural(Math.floor(deltaMs / MONTH), "month");
  return plural(Math.floor(deltaMs / YEAR), "year");
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

// ─── Cross-repo receipts (Phase-2 Slice B) ────────────────────────────────
//
// Outgoing PRs that AntFleet opens on third-party repos (where the App is
// not installed) live in the `outgoing_prs` table. The poll loop in
// lib/outgoing-prs.ts transitions rows open → merged | closed; this loader
// reads only the merged ones for /receipts and /receipts.rss. Kept here
// (rather than in outgoing-prs.ts) so the page's two receipt loaders sit
// side by side — the write/poll path is its own module.

export type CrossRepoReceiptRow = {
  id: string;
  sourceFindingId: string;
  upstreamOwner: string;
  upstreamRepo: string;
  upstreamPrNumber: number;
  // For merged: mergedAt/mergeSha. For absorbed: closureDetectedAt/closureSha.
  resolvedAt: Date;
  resolutionSha: string;
  prUrl: string;
  // "merged" or "absorbed_inline" — drives the badge on the receipts page.
  closureMethod: string;
};

export type CrossRepoReceiptsPage = {
  total: number;
  recent: CrossRepoReceiptRow[];
  lastResolvedAt: Date | null;
};

export type CrossRepoReceiptsWindow = CrossRepoReceiptsPage;

export function upstreamPrUrl(owner: string, repo: string, number: number): string {
  return `https://github.com/${owner}/${repo}/pull/${number}`;
}

// Pure mapping from raw outgoing_prs rows to the display shape. Handles
// both merged rows (receipt via merge SHA) and absorbed rows (receipt via
// closure SHA). Drops rows missing the receipt-bearing columns as a
// belt-and-braces guard. Extracted from the DB function so it can be
// unit-tested without a database.
export function mapReceiptEligibleRows(rows: readonly OutgoingPr[]): {
  receipts: CrossRepoReceiptRow[];
  lastResolvedAt: Date | null;
} {
  const receipts: CrossRepoReceiptRow[] = [];
  let lastResolvedAt: Date | null = null;
  for (const r of rows) {
    let resolvedAt: Date | null = null;
    let resolutionSha: string | null = null;
    let closureMethod = r.closureMethod ?? "merged";

    if (r.status === "merged") {
      resolvedAt = r.mergedAt;
      resolutionSha = r.mergeSha;
      closureMethod = "merged";
    } else if (r.status === "closed_absorbed") {
      resolvedAt = r.closureDetectedAt;
      resolutionSha = r.closureSha;
      closureMethod = "absorbed_inline";
    }

    if (resolvedAt === null || resolutionSha === null) continue;
    if (lastResolvedAt === null || resolvedAt > lastResolvedAt) {
      lastResolvedAt = resolvedAt;
    }
    receipts.push({
      id: r.id,
      sourceFindingId: r.sourceFindingId,
      upstreamOwner: r.upstreamOwner,
      upstreamRepo: r.upstreamRepo,
      upstreamPrNumber: r.upstreamPrNumber,
      resolvedAt,
      resolutionSha,
      prUrl: upstreamPrUrl(r.upstreamOwner, r.upstreamRepo, r.upstreamPrNumber),
      closureMethod,
    });
  }
  return { receipts, lastResolvedAt };
}

// Visibility gate — hide a cross-repo receipt only when its source finding
// is positively known to be private (publicReceipt=false on the review or
// the finding was retracted). Orphan outgoing_prs rows (sourceFindingId has
// no matching finding_status row, e.g. bench/manual-onboarding seeds) pass
// through: they are upstream PRs AntFleet itself opened, never private.
// Same privacy contract as /receipts in the "known public" case, more
// permissive than loadPublicReceiptsPage for the "unknown source" case.
// Fail-closed even with the disclosure gate off: besides retracted findings and
// non-public reviews, exclude any source finding that is in an active-embargo
// disclosure state (anything other than 'none'/'published'). A finding with no
// finding_disclosure row (not yet backfilled) is still treated as public, so no
// legitimate cross-repo receipt is hidden — we only fail closed on an explicit
// embargo, so an operator clearing a disclosure flag can't leak a mid-embargo
// live-protocol finding here (audit M4).
const legacyPublicReceiptGate = sql`NOT EXISTS (
  SELECT 1 FROM ${findingStatus}
  INNER JOIN ${reviews} ON ${reviews.reviewId} = ${findingStatus.reviewId}
  LEFT JOIN ${findingDisclosure} ON ${findingDisclosure.findingId} = ${findingStatus.findingId}
  WHERE ${findingStatus.findingId} = ${outgoingPrs.sourceFindingId}
    AND (
      ${findingStatus.retractedAt} IS NOT NULL
      OR ${reviews.publicReceipt} = false
      OR (
        ${findingDisclosure.findingId} IS NOT NULL
        AND ${findingDisclosure.state} NOT IN ('none', 'published')
      )
    )
)`;

const disclosurePublicReceiptGate = sql`NOT EXISTS (
  SELECT 1 FROM ${findingStatus}
  INNER JOIN ${reviews} ON ${reviews.reviewId} = ${findingStatus.reviewId}
  LEFT JOIN ${findingDisclosure} ON ${findingDisclosure.findingId} = ${findingStatus.findingId}
  WHERE ${findingStatus.findingId} = ${outgoingPrs.sourceFindingId}
    AND (
      ${findingStatus.retractedAt} IS NOT NULL
      OR ${findingDisclosure.findingId} IS NULL
      OR NOT (
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
)`;

// Cyber-tier exclusion for cross-repo receipts. Hides an outgoing-PR row
// whenever its source review's repo is classified cyber. Defense-in-depth
// alongside the public-receipt gate. When ANTFLEET_CYBER_TIER is OFF the
// fragment collapses to `true` and behavior is byte-identical.
const cyberTierExclusionForOutgoingPrs = sql`(
  ${outgoingPrs.sourceFindingId} IS NULL
  OR NOT EXISTS (
    SELECT 1
    FROM ${findingStatus} cyber_fs
    INNER JOIN ${reviews} cyber_r ON cyber_r.review_id = cyber_fs.review_id
    INNER JOIN repo_tier cyber_rt
      ON cyber_rt.owner_lc = lower(cyber_r.owner)
      AND cyber_rt.repo_lc = lower(cyber_r.repo)
    WHERE cyber_fs.finding_id = ${outgoingPrs.sourceFindingId}
      AND cyber_rt.tier = 'cyber'
  )
)`;

function publicReceiptGate() {
  const visibility = isDisclosureGateEnabled()
    ? disclosurePublicReceiptGate
    : legacyPublicReceiptGate;
  if (!isCyberTierEnabled()) return visibility;
  return and(visibility, cyberTierExclusionForOutgoingPrs);
}

export async function loadCrossRepoReceipts(limit: number): Promise<CrossRepoReceiptsPage> {
  const receiptStatuses = ["merged", "closed_absorbed"];
  const baseFilter = and(inArray(outgoingPrs.status, receiptStatuses), publicReceiptGate());
  const rows = (await db
    .select()
    .from(outgoingPrs)
    .where(baseFilter)
    .orderBy(
      sql`COALESCE(${outgoingPrs.mergedAt}, ${outgoingPrs.closureDetectedAt}) DESC NULLS LAST`,
    )
    .limit(limit)) as OutgoingPr[];

  const { receipts, lastResolvedAt } = mapReceiptEligibleRows(rows);

  const [countRow] = await db
    .select({ value: sql<number>`count(*)::int`.as("value") })
    .from(outgoingPrs)
    .where(baseFilter);

  return { total: countRow?.value ?? 0, recent: receipts, lastResolvedAt };
}

export async function loadCrossRepoReceiptsBetween(
  since: Date,
  until: Date,
  limit: number,
): Promise<CrossRepoReceiptsWindow> {
  if (until.getTime() <= since.getTime() || limit <= 0) {
    return { total: 0, recent: [], lastResolvedAt: null };
  }

  const receiptStatuses = ["merged", "closed_absorbed"];
  const resolvedAt = sql`COALESCE(${outgoingPrs.mergedAt}, ${outgoingPrs.closureDetectedAt})`;
  const windowFilter = and(
    inArray(outgoingPrs.status, receiptStatuses),
    sql`${resolvedAt} >= ${since}`,
    sql`${resolvedAt} < ${until}`,
    publicReceiptGate(),
  );

  const rows = (await db
    .select()
    .from(outgoingPrs)
    .where(windowFilter)
    .orderBy(sql`${resolvedAt} DESC NULLS LAST`)
    .limit(limit)) as OutgoingPr[];

  const { receipts, lastResolvedAt } = mapReceiptEligibleRows(rows);

  const [countRow] = await db
    .select({ value: sql<number>`count(*)::int`.as("value") })
    .from(outgoingPrs)
    .where(windowFilter);

  return { total: countRow?.value ?? 0, recent: receipts, lastResolvedAt };
}

// Phase-2 P2-E — detail-page adapter. Maps a single-receipt query row into
// a richer view-model that surfaces the agent attribution (model versions
// for both reviewers, per-provider timing, the full finding body) and the
// closure timing math. Same privacy boundary as the list adapter: only
// repo_hash crosses, never owner/repo.
export type DisplayReceiptDetail = DisplayReceipt & {
  reviewId: string;
  reviewIdShort: string;
  reviewerLabels: string[]; // ordered ["claude-opus-4-7", "gpt-5"], for "Reviewed by …"
  providerTimings: Array<{ name: string; ms: number | null; ok: boolean }>;
  reviewedAtIso: string;
  relativeReviewedAt: string;
  closureLagText: string | null; // "closed in 4 hours" — null when closedAt is null
  totalReviewMs: number;
  estimatedCostUsd: string;
  finding: {
    severity: string;
    category: string;
    title: string;
    reasoning: string | null;
    recommendation: string | null;
    evidence: Array<{ path: string; startLine: number | null; endLine: number | null }>;
  };
  originalCommentUrl: string | null;
  prLinkUrl: string | null;
};

export function toDisplayReceiptDetail(
  row: PublicReceiptDetailRow,
  now: Date,
): DisplayReceiptDetail {
  const base = toDisplayReceipt(row, now);
  const reviewerLabels = extractModelLabels(row.providerModelIds);
  const providerTimings = extractProviderTimings(row.providerResponses);
  const finding = extractFindingAtIndex(row.agreementDecision, row.findingIndex) ?? {
    severity: row.severity,
    category: row.category,
    title: row.title,
    reasoning: null,
    recommendation: null,
    evidence: [],
  };
  const closureLagText =
    row.closedAt === null ? null : `closed in ${closureLag(row.reviewCreatedAt, row.closedAt)}`;

  return {
    ...base,
    reviewId: row.reviewId,
    reviewIdShort: shortenReviewId(row.reviewId),
    reviewerLabels,
    providerTimings,
    reviewedAtIso: row.reviewCreatedAt.toISOString(),
    relativeReviewedAt: formatRelativeTime(now, row.reviewCreatedAt),
    closureLagText,
    totalReviewMs: row.timingMs,
    estimatedCostUsd: row.costEstimatedUsd,
    finding,
    originalCommentUrl: row.prCommentUrl,
    // Reconstruct the PR URL from the closure-comment URL when present —
    // both contain owner/repo. We don't surface owner/repo directly but
    // the link itself is the third-party-witnessed receipt, so the URL is
    // load-bearing per §18.2. Strip the `#issuecomment-<id>` fragment to
    // get to the PR top.
    prLinkUrl:
      row.closureCommentUrl === null ? null : (row.closureCommentUrl.split("#")[0] ?? null),
  };
}

function closureLag(reviewedAt: Date, closedAt: Date): string {
  const deltaMs = Math.max(0, closedAt.getTime() - reviewedAt.getTime());
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  if (deltaMs < MINUTE) return "<1 minute";
  if (deltaMs < HOUR) return plural(Math.floor(deltaMs / MINUTE), "minute").replace(" ago", "");
  if (deltaMs < DAY) return plural(Math.floor(deltaMs / HOUR), "hour").replace(" ago", "");
  return plural(Math.floor(deltaMs / DAY), "day").replace(" ago", "");
}

function extractModelLabels(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const out: string[] = [];
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) out.push(value);
  }
  return out;
}

function extractProviderTimings(
  raw: unknown,
): Array<{ name: string; ms: number | null; ok: boolean }> {
  if (typeof raw !== "object" || raw === null) return [];
  const perProvider = (raw as Record<string, unknown>)["perProvider"];
  if (!Array.isArray(perProvider)) return [];
  const out: Array<{ name: string; ms: number | null; ok: boolean }> = [];
  for (const entry of perProvider) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e["name"] === "string" ? e["name"] : null;
    if (name === null) continue;
    const ms = typeof e["ms"] === "number" ? e["ms"] : null;
    const ok = e["ok"] === true;
    out.push({ name, ms, ok });
  }
  return out;
}

function extractFindingAtIndex(
  raw: unknown,
  index: number,
): {
  severity: string;
  category: string;
  title: string;
  reasoning: string | null;
  recommendation: string | null;
  evidence: Array<{ path: string; startLine: number | null; endLine: number | null }>;
} | null {
  if (typeof raw !== "object" || raw === null) return null;
  const agreed = (raw as Record<string, unknown>)["agreed"];
  if (!Array.isArray(agreed)) return null;
  const f = agreed[index];
  if (typeof f !== "object" || f === null) return null;
  const ff = f as Record<string, unknown>;
  const severity = typeof ff["severity"] === "string" ? ff["severity"] : null;
  const category = typeof ff["category"] === "string" ? ff["category"] : null;
  const title = typeof ff["title"] === "string" ? ff["title"] : null;
  if (severity === null || category === null || title === null) return null;
  const reasoning = typeof ff["reasoning"] === "string" ? ff["reasoning"] : null;
  const recommendation = typeof ff["recommendation"] === "string" ? ff["recommendation"] : null;
  const evRaw = ff["evidence"];
  const evidence: Array<{ path: string; startLine: number | null; endLine: number | null }> = [];
  if (Array.isArray(evRaw)) {
    for (const ev of evRaw) {
      if (typeof ev !== "object" || ev === null) continue;
      const e = ev as Record<string, unknown>;
      const path = typeof e["path"] === "string" ? e["path"] : null;
      if (path === null) continue;
      const startLine = typeof e["startLine"] === "number" ? e["startLine"] : null;
      const endLine = typeof e["endLine"] === "number" ? e["endLine"] : null;
      evidence.push({ path, startLine, endLine });
    }
  }
  return { severity, category, title, reasoning, recommendation, evidence };
}
