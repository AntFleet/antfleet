import { and, count, desc, lt, max, sql } from "drizzle-orm";
import { db } from "@/db/index";
import { reviews } from "@/db/schema";
import { embargoSafePublicReceiptCondition } from "@/db/public-receipt";
import { isDisclosureGateEnabled } from "@/lib/daybreak-gates-env";
import { nonCyberTierRepoCondition } from "@/lib/cyber-tier";
import { shortenReviewId } from "@/lib/short-id";

export type DisagreementCategory = "solo_anthropic" | "solo_openai" | "mismatched_classification";

export type ProviderFinding = {
  provider: string;
  title: string;
  category: string;
  severity: string;
  confidence: string;
  evidence: Array<{
    path: string;
    startLine: number | null;
    endLine: number | null;
  }>;
  reasoning: string;
  recommendation: string;
};

export type DisagreementRow = {
  id: string;
  reviewId: string;
  category: DisagreementCategory;
  repoHash: string;
  prNumber: number;
  primaryFinding: ProviderFinding;
  counterpartFinding: ProviderFinding | null;
  createdAt: Date;
};

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  med: 2,
  high: 3,
  critical: 4,
};

function reviewPublicGate() {
  // Cyber-tier exclusion AND'd in defense-in-depth. Without it, the
  // disagreement archive / detail / RSS / OG image loaders would expose
  // cyber-repo reviewer findings on an unauthenticated public surface
  // whenever ANTFLEET_CYBER_TIER is on (security audit pass-1, high).
  return and(
    isDisclosureGateEnabled() ? sql<boolean>`false` : embargoSafePublicReceiptCondition,
    nonCyberTierRepoCondition(),
  );
}

type Evidence = ProviderFinding["evidence"][number];
type IndexedFinding = ProviderFinding & { originalIndex: number };
type ProviderFindings = Map<string, IndexedFinding[]>;
type ReviewSource = {
  reviewId: string;
  repoHash: string;
  prNumber: number;
  providerResponses: unknown;
  agreementDecision: unknown;
  createdAt: Date;
};

export function evidenceOverlaps(
  aEvidence: Array<{ path: string; startLine: number | null; endLine: number | null }>,
  bEvidence: Array<{ path: string; startLine: number | null; endLine: number | null }>,
  tolerance: number = 5,
): boolean {
  for (const a of aEvidence) {
    for (const b of bEvidence) {
      if (a.path !== b.path) continue;
      if (a.startLine === null && b.startLine === null) return true;
      if (a.startLine === null || b.startLine === null) continue;

      const aEnd = a.endLine ?? a.startLine;
      const bEnd = b.endLine ?? b.startLine;
      if (a.startLine <= bEnd + tolerance && b.startLine <= aEnd + tolerance) return true;
    }
  }
  return false;
}

export function classifyDisagreements(
  providerResponses: unknown,
  agreementDecision: unknown,
  reviewId: string,
  repoHash: string,
  prNumber: number,
  createdAt: Date,
): DisagreementRow[] {
  const providerFindings = parseProviderFindings(providerResponses);
  if (providerFindings === null || providerFindings.size < 2) return [];

  const providers = selectComparisonProviders(providerFindings);
  if (providers === null) return [];

  const rows: DisagreementRow[] = [];
  const seenIds = new Set<string>();
  const seenMismatchPairs = new Set<string>();
  const [providerA, providerB] = providers;

  addPerspectiveRows({
    rows,
    seenIds,
    seenMismatchPairs,
    sourceProvider: providerA,
    counterpartProvider: providerB,
    providerFindings,
    reviewId,
    repoHash,
    prNumber,
    createdAt,
  });
  addPerspectiveRows({
    rows,
    seenIds,
    seenMismatchPairs,
    sourceProvider: providerB,
    counterpartProvider: providerA,
    providerFindings,
    reviewId,
    repoHash,
    prNumber,
    createdAt,
  });
  addAgreementDecisionRows({
    rows,
    seenIds,
    seenMismatchPairs,
    agreementDecision,
    providerFindings,
    reviewId,
    repoHash,
    prNumber,
    createdAt,
  });

  return rows;
}

export async function loadDisagreementsPage(args: { limit: number; before?: Date }): Promise<{
  rows: DisagreementRow[];
  hasMore: boolean;
  totalCount: number;
  lastUpdatedAt: Date | null;
}> {
  // H5 fix: use a cheap aggregate query (COUNT + MAX) to compute totalCount and
  // lastUpdatedAt without selecting the heavy provider_responses JSONB column.
  // The actual page rows still need provider_responses but only for the bounded
  // slice, not the full table scan.
  const [aggResult, pageReviewRows] = await Promise.all([
    loadDisagreementsAggregate(),
    loadPublicReviewSources({
      before: args.before,
      limit: Math.max(200, args.limit * 20 + 1),
    }),
  ]);

  const pageRows = flattenDisagreements(pageReviewRows);

  return {
    rows: pageRows.slice(0, args.limit),
    hasMore: pageRows.length > args.limit,
    totalCount: aggResult.totalReviewCount,
    lastUpdatedAt: aggResult.lastCreatedAt,
  };
}

// Cheap aggregate: COUNT(*) + MAX(created_at) without fetching provider_responses.
// Used for the totalCount and lastUpdatedAt fields shown in the OG image and
// RSS feed. NOTE: totalCount counts reviews with provider_responses, not the
// disagrement-row count which requires JSONB parsing — callers that previously
// used allRows.length now get the raw review count instead. This is acceptable
// because the OG image only displays the number for visual scale, not strict
// disagrement accounting, and avoids a full-table JSONB scan on every request.
export async function loadDisagreementsAggregate(): Promise<{
  totalReviewCount: number;
  lastCreatedAt: Date | null;
}> {
  const rows = await db
    .select({
      totalReviewCount: count(),
      lastCreatedAt: max(reviews.createdAt),
    })
    .from(reviews)
    .where(and(reviewPublicGate(), sql`${reviews.providerResponses} IS NOT NULL`));
  const row = rows[0];
  return {
    totalReviewCount: row?.totalReviewCount ?? 0,
    lastCreatedAt: row?.lastCreatedAt ?? null,
  };
}

export async function loadDisagreementDetail(id: string): Promise<DisagreementRow | null> {
  const parsed = parseDisagreementId(id);
  if (parsed === null) return null;

  const rows = await db
    .select({
      reviewId: reviews.reviewId,
      repoHash: reviews.repoHash,
      prNumber: reviews.prNumber,
      providerResponses: reviews.providerResponses,
      agreementDecision: reviews.agreementDecision,
      createdAt: reviews.createdAt,
    })
    .from(reviews)
    .where(
      and(reviewPublicGate(), sql`${reviews.reviewId}::text LIKE ${`${parsed.reviewIdShort}%`}`),
    )
    .limit(10);

  for (const review of rows) {
    const disagreement = classifyDisagreements(
      review.providerResponses,
      review.agreementDecision,
      review.reviewId,
      review.repoHash,
      review.prNumber,
      review.createdAt,
    ).find((row) => row.id === id);
    if (disagreement !== undefined) return disagreement;
  }
  return null;
}

export function redactSecrets(text: string): string {
  return text
    .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
    .replace(
      /\b(key|token|secret|password|api_key)(\s*[:=]\s*["']?)([A-Za-z0-9+/_=-]{20,})(["']?)/gi,
      "$1$2[REDACTED]$4",
    );
}

function addPerspectiveRows(args: {
  rows: DisagreementRow[];
  seenIds: Set<string>;
  seenMismatchPairs: Set<string>;
  sourceProvider: string;
  counterpartProvider: string;
  providerFindings: ProviderFindings;
  reviewId: string;
  repoHash: string;
  prNumber: number;
  createdAt: Date;
}): void {
  const sourceFindings = args.providerFindings.get(args.sourceProvider) ?? [];
  const counterpartFindings = args.providerFindings.get(args.counterpartProvider) ?? [];

  for (const finding of sourceFindings) {
    const counterpart = counterpartFindings.find((candidate) =>
      evidenceOverlaps(finding.evidence, candidate.evidence),
    );

    if (counterpart === undefined) {
      const category = soloCategory(args.sourceProvider);
      if (category === null) continue;
      addRow(args.rows, args.seenIds, {
        id: disagreementId(args.reviewId, finding.provider, finding.originalIndex),
        reviewId: args.reviewId,
        category,
        repoHash: args.repoHash,
        prNumber: args.prNumber,
        primaryFinding: stripIndex(finding),
        counterpartFinding: null,
        createdAt: args.createdAt,
      });
      continue;
    }

    if (sameClassification(finding, counterpart)) continue;

    const pairKey = mismatchPairKey(finding, counterpart);
    if (args.seenMismatchPairs.has(pairKey)) continue;
    args.seenMismatchPairs.add(pairKey);

    const primary = choosePrimaryFinding(finding, counterpart);
    const other = primary === finding ? counterpart : finding;
    addRow(args.rows, args.seenIds, {
      id: disagreementId(args.reviewId, primary.provider, primary.originalIndex),
      reviewId: args.reviewId,
      category: "mismatched_classification",
      repoHash: args.repoHash,
      prNumber: args.prNumber,
      primaryFinding: stripIndex(primary),
      counterpartFinding: stripIndex(other),
      createdAt: args.createdAt,
    });
  }
}

function addAgreementDecisionRows(args: {
  rows: DisagreementRow[];
  seenIds: Set<string>;
  seenMismatchPairs: Set<string>;
  agreementDecision: unknown;
  providerFindings: ProviderFindings;
  reviewId: string;
  repoHash: string;
  prNumber: number;
  createdAt: Date;
}): void {
  if (!isRecord(args.agreementDecision)) return;
  const disagreements = args.agreementDecision["disagreements"];
  if (!Array.isArray(disagreements)) return;

  for (const entry of disagreements) {
    if (!isRecord(entry)) continue;
    const providers = Array.isArray(entry["providers"])
      ? entry["providers"].filter((provider): provider is string => typeof provider === "string")
      : [];
    const provider = providers.find((candidate) => args.providerFindings.has(candidate));
    if (provider === undefined) continue;

    const parsed = parseFinding(provider, entry["finding"], -1);
    if (parsed === null) continue;

    const providerFinding = findIndexedFinding(args.providerFindings.get(provider) ?? [], parsed);
    if (providerFinding === null) continue;

    const counterpart = findCounterpartFinding(args.providerFindings, providers, providerFinding);
    if (counterpart !== null && !sameClassification(providerFinding, counterpart)) {
      const pairKey = mismatchPairKey(providerFinding, counterpart);
      if (args.seenMismatchPairs.has(pairKey)) continue;
      args.seenMismatchPairs.add(pairKey);

      const primary = choosePrimaryFinding(providerFinding, counterpart);
      const other = primary === providerFinding ? counterpart : providerFinding;
      addRow(args.rows, args.seenIds, {
        id: disagreementId(args.reviewId, primary.provider, primary.originalIndex),
        reviewId: args.reviewId,
        category: "mismatched_classification",
        repoHash: args.repoHash,
        prNumber: args.prNumber,
        primaryFinding: stripIndex(primary),
        counterpartFinding: stripIndex(other),
        createdAt: args.createdAt,
      });
      continue;
    }

    const category = soloCategory(providerFinding.provider);
    if (category === null) continue;
    addRow(args.rows, args.seenIds, {
      id: disagreementId(args.reviewId, providerFinding.provider, providerFinding.originalIndex),
      reviewId: args.reviewId,
      category,
      repoHash: args.repoHash,
      prNumber: args.prNumber,
      primaryFinding: stripIndex(providerFinding),
      counterpartFinding: null,
      createdAt: args.createdAt,
    });
  }
}

function addRow(rows: DisagreementRow[], seenIds: Set<string>, row: DisagreementRow): void {
  if (seenIds.has(row.id)) return;
  seenIds.add(row.id);
  rows.push(row);
}

function parseProviderFindings(providerResponses: unknown): ProviderFindings | null {
  if (!isRecord(providerResponses)) return null;
  if (providerResponses["status"] === "skipped") return null;

  const perProvider = providerResponses["perProvider"];
  if (!Array.isArray(perProvider)) return null;

  const providerFindings: ProviderFindings = new Map();
  for (const providerEntry of perProvider) {
    if (!isRecord(providerEntry)) continue;
    const name = providerEntry["name"];
    if (typeof name !== "string" || name.length === 0) continue;

    const output = providerEntry["output"];
    const rawFindings =
      isRecord(output) && Array.isArray(output["findings"]) ? output["findings"] : [];
    const findings: IndexedFinding[] = [];
    for (let index = 0; index < rawFindings.length; index += 1) {
      const parsed = parseFinding(name, rawFindings[index], index);
      if (parsed !== null) findings.push(parsed);
    }
    providerFindings.set(name, findings);
  }

  return providerFindings;
}

function parseFinding(
  provider: string,
  value: unknown,
  originalIndex: number,
): IndexedFinding | null {
  if (!isRecord(value)) return null;
  return {
    provider,
    originalIndex,
    title: stringValue(value["title"]),
    category: stringValue(value["category"]),
    severity: stringValue(value["severity"]),
    confidence: stringValue(value["confidence"]),
    evidence: parseEvidence(value["evidence"]),
    reasoning: stringValue(value["reasoning"]),
    recommendation: stringValue(value["recommendation"]),
  };
}

function parseEvidence(value: unknown): Evidence[] {
  if (!Array.isArray(value)) return [];
  const evidence: Evidence[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const path = entry["path"];
    if (typeof path !== "string" || path.length === 0) continue;
    evidence.push({
      path,
      startLine: nullableNumber(entry["startLine"]),
      endLine: nullableNumber(entry["endLine"]),
    });
  }
  return evidence;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function selectComparisonProviders(providerFindings: ProviderFindings): [string, string] | null {
  if (providerFindings.has("anthropic") && providerFindings.has("openai")) {
    return ["anthropic", "openai"];
  }

  const providers = [...providerFindings.keys()].toSorted();
  if (providers.length < 2 || providers[0] === undefined || providers[1] === undefined) return null;
  return [providers[0], providers[1]];
}

function sameClassification(a: ProviderFinding, b: ProviderFinding): boolean {
  return (
    normalize(a.severity) === normalize(b.severity) &&
    normalize(a.category) === normalize(b.category)
  );
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function choosePrimaryFinding(a: IndexedFinding, b: IndexedFinding): IndexedFinding {
  const aRank = severityRank(a.severity);
  const bRank = severityRank(b.severity);
  if (aRank > bRank) return a;
  if (bRank > aRank) return b;
  return a.provider.localeCompare(b.provider) <= 0 ? a : b;
}

function severityRank(severity: string): number {
  return SEVERITY_RANK[normalize(severity)] ?? -1;
}

function soloCategory(provider: string): DisagreementCategory | null {
  if (provider === "anthropic") return "solo_anthropic";
  if (provider === "openai") return "solo_openai";
  return null;
}

function disagreementId(reviewId: string, provider: string, findingIndex: number): string {
  return `${shortenReviewId(reviewId)}-${provider}-${findingIndex}`;
}

function mismatchPairKey(a: IndexedFinding, b: IndexedFinding): string {
  return [findingKey(a), findingKey(b)].toSorted().join("|");
}

function findingKey(finding: IndexedFinding): string {
  return `${finding.provider}:${finding.originalIndex}`;
}

function stripIndex(finding: IndexedFinding): ProviderFinding {
  return {
    provider: finding.provider,
    title: finding.title,
    category: finding.category,
    severity: finding.severity,
    confidence: finding.confidence,
    evidence: finding.evidence,
    reasoning: finding.reasoning,
    recommendation: finding.recommendation,
  };
}

function findIndexedFinding(
  candidates: IndexedFinding[],
  target: ProviderFinding,
): IndexedFinding | null {
  return (
    candidates.find(
      (candidate) =>
        candidate.title === target.title &&
        normalize(candidate.category) === normalize(target.category) &&
        normalize(candidate.severity) === normalize(target.severity) &&
        evidenceOverlaps(candidate.evidence, target.evidence),
    ) ?? null
  );
}

function findCounterpartFinding(
  providerFindings: ProviderFindings,
  disagreementProviders: string[],
  primary: IndexedFinding,
): IndexedFinding | null {
  const candidateProviders =
    disagreementProviders.length > 0
      ? disagreementProviders.filter((provider) => provider !== primary.provider)
      : [...providerFindings.keys()].filter((provider) => provider !== primary.provider);

  for (const provider of candidateProviders) {
    const findings = providerFindings.get(provider) ?? [];
    const match = findings.find((finding) => evidenceOverlaps(primary.evidence, finding.evidence));
    if (match !== undefined) return match;
  }
  return null;
}

async function loadPublicReviewSources(args?: {
  before?: Date;
  limit?: number;
}): Promise<ReviewSource[]> {
  const where =
    args?.before === undefined
      ? and(reviewPublicGate(), sql`${reviews.providerResponses} IS NOT NULL`)
      : and(
          reviewPublicGate(),
          sql`${reviews.providerResponses} IS NOT NULL`,
          lt(reviews.createdAt, args.before),
        );

  const query = db
    .select({
      reviewId: reviews.reviewId,
      repoHash: reviews.repoHash,
      prNumber: reviews.prNumber,
      providerResponses: reviews.providerResponses,
      agreementDecision: reviews.agreementDecision,
      createdAt: reviews.createdAt,
    })
    .from(reviews)
    .where(where)
    .orderBy(desc(reviews.createdAt));

  if (args?.limit !== undefined) return query.limit(args.limit);
  return query;
}

function flattenDisagreements(reviewsToClassify: ReviewSource[]): DisagreementRow[] {
  return reviewsToClassify.flatMap((review) =>
    classifyDisagreements(
      review.providerResponses,
      review.agreementDecision,
      review.reviewId,
      review.repoHash,
      review.prNumber,
      review.createdAt,
    ),
  );
}

function parseDisagreementId(
  id: string,
): { reviewIdShort: string; provider: string; findingIndex: number } | null {
  // Review short IDs are always 8 hex chars (UUID prefix). Provider names may
  // contain hyphens (e.g., "google-ai"), so we anchor on the known prefix
  // length and the trailing -\d+ to extract the provider segment.
  const match = /^([0-9a-f]{8})-(.+)-(\d+)$/.exec(id);
  if (match === null) return null;
  const reviewIdShort = match[1];
  const provider = match[2];
  const findingIndexText = match[3];
  if (reviewIdShort === undefined || provider === undefined || findingIndexText === undefined)
    return null;
  return {
    reviewIdShort,
    provider,
    findingIndex: Number.parseInt(findingIndexText, 10),
  };
}
