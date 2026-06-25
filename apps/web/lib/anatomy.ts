import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/index";
import { derivedPublicReceiptCondition } from "@/db/public-receipt";
import { findingDisclosure, findingStatus, reviews } from "@/db/schema";
import { isDisclosureGateEnabled } from "@/lib/daybreak-gates-env";
import { nonCyberTierRepoCondition } from "@/lib/cyber-tier";
import { evidenceOverlaps } from "@/lib/disagreements";

export type ProviderReasoning = {
  provider: string;
  title: string;
  category: string;
  severity: string;
  confidence: string;
  evidence: Array<{ path: string; startLine: number | null; endLine: number | null }>;
  reasoning: string;
  recommendation: string;
};

export type AnatomyBundle = {
  findingId: string;
  severity: string;
  category: string;
  title: string;
  repoHash: string;
  prNumber: number;
  status: string;
  closureSha: string | null;
  closureCommentUrl: string | null;
  closedAt: Date | null;
  createdAt: Date;
  // Retraction surface (migration 0030). Non-null retractedAt flips the page
  // into its retracted state: no JSON-LD, noindex, retraction notice body.
  retractedAt: Date | null;
  retractionReason: string | null;
  reasoning: {
    anthropic: ProviderReasoning | null;
    openai: ProviderReasoning | null;
  };
  source: {
    owner: string;
    repo: string;
    installationId: number;
    prSha: string;
    file: string;
    lineStart: number;
    lineEnd: number;
  };
};

export async function loadAnatomyBundle(findingId: string): Promise<AnatomyBundle | null> {
  const disclosureGateEnabled = isDisclosureGateEnabled();
  const visibilityCondition = and(
    disclosureGateEnabled ? derivedPublicReceiptCondition : eq(reviews.publicReceipt, true),
    nonCyberTierRepoCondition(),
  );
  const selectColumns = {
    findingId: findingStatus.findingId,
    findingIndex: findingStatus.findingIndex,
    severity: findingStatus.severity,
    category: findingStatus.category,
    title: findingStatus.title,
    status: findingStatus.status,
    closureSha: findingStatus.closureSha,
    closureCommentUrl: findingStatus.closureCommentUrl,
    closedAt: findingStatus.closureDetectedAt,
    createdAt: findingStatus.createdAt,
    retractedAt: findingStatus.retractedAt,
    retractionReason: findingStatus.retractionReason,
    repoHash: reviews.repoHash,
    prNumber: reviews.prNumber,
    commitSha: reviews.commitSha,
    owner: reviews.owner,
    repo: reviews.repo,
    installationId: reviews.installationId,
    providerResponses: reviews.providerResponses,
    agreementDecision: reviews.agreementDecision,
    reviewHasPrivateDisclosure: sql<boolean>`EXISTS (
      SELECT 1
      FROM ${findingStatus} review_fs
      LEFT JOIN ${findingDisclosure} review_fd
        ON review_fd.finding_id = review_fs.finding_id
      WHERE review_fs.review_id = ${reviews.reviewId}
        AND (
          review_fd.finding_id IS NULL
          OR NOT (
            (
	              review_fd.state = 'published'
	              AND (
	                (
	                  review_fd.ghsa_id IS NULL
	                  AND review_fs.closure_comment_url IS NOT NULL
	                )
	                OR (
	                  review_fd.ghsa_id IS NOT NULL
	                  AND review_fd.ghsa_published_at IS NOT NULL
	                  AND review_fd.ghsa_html_url IS NOT NULL
	                )
	              )
            )
            OR (
              review_fd.state = 'none'
              AND ${reviews.publicReceipt} = true
            )
          )
        )
    )`,
  };
  const rows = await (disclosureGateEnabled
    ? db
        .select(selectColumns)
        .from(findingStatus)
        .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
        .leftJoin(findingDisclosure, eq(findingDisclosure.findingId, findingStatus.findingId))
        .where(and(eq(findingStatus.findingId, findingId), visibilityCondition))
        .limit(1)
    : db
        .select(selectColumns)
        .from(findingStatus)
        .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
        .where(and(eq(findingStatus.findingId, findingId), visibilityCondition))
        .limit(1));

  const row = rows[0];
  if (row === undefined) return null;

  const agreed = extractAgreedFinding(row.agreementDecision, row.findingIndex);
  const evidence = agreed?.evidence ?? [];
  const firstEvidence = evidence[0];
  const canRenderProviderReasoning =
    !disclosureGateEnabled || row.reviewHasPrivateDisclosure !== true;

  return {
    findingId: row.findingId,
    severity: row.severity,
    category: row.category,
    title: row.title,
    repoHash: row.repoHash,
    prNumber: row.prNumber,
    status: row.status,
    closureSha: row.closureSha,
    closureCommentUrl: row.closureCommentUrl,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
    retractedAt: row.retractedAt,
    retractionReason: row.retractionReason,
    reasoning: {
      anthropic: canRenderProviderReasoning
        ? extractProviderReasoning(row.providerResponses, "anthropic", evidence)
        : null,
      openai: canRenderProviderReasoning
        ? extractProviderReasoning(row.providerResponses, "openai", evidence)
        : null,
    },
    source: {
      owner: row.owner ?? "",
      repo: row.repo ?? "",
      installationId: row.installationId ?? 0,
      prSha: row.commitSha,
      file: firstEvidence?.path ?? "",
      lineStart: firstEvidence?.startLine ?? 0,
      lineEnd: firstEvidence?.endLine ?? 0,
    },
  };
}

type ParsedEvidence = { path: string; startLine: number | null; endLine: number | null };

function extractAgreedFinding(
  agreementDecision: unknown,
  findingIndex: number,
): { evidence: ParsedEvidence[] } | null {
  if (!isRecord(agreementDecision)) return null;
  const agreed = agreementDecision["agreed"];
  if (!Array.isArray(agreed)) return null;
  const finding = agreed[findingIndex];
  if (!isRecord(finding)) return null;
  return { evidence: parseEvidence(finding["evidence"]) };
}

function extractProviderReasoning(
  providerResponses: unknown,
  providerName: string,
  agreedEvidence: ParsedEvidence[],
): ProviderReasoning | null {
  if (!isRecord(providerResponses)) return null;
  const perProvider = providerResponses["perProvider"];
  if (!Array.isArray(perProvider)) return null;

  for (const entry of perProvider) {
    if (!isRecord(entry)) continue;
    if (entry["name"] !== providerName) continue;

    const output = entry["output"];
    if (!isRecord(output)) return null;
    const findings = output["findings"];
    if (!Array.isArray(findings)) return null;

    for (const finding of findings) {
      if (!isRecord(finding)) continue;
      const evidence = parseEvidence(finding["evidence"]);
      if (agreedEvidence.length > 0 && evidenceOverlaps(evidence, agreedEvidence)) {
        return {
          provider: providerName,
          title: str(finding["title"]),
          category: str(finding["category"]),
          severity: str(finding["severity"]),
          confidence: str(finding["confidence"]),
          evidence,
          reasoning: str(finding["reasoning"]),
          recommendation: str(finding["recommendation"]),
        };
      }
    }
    return null;
  }
  return null;
}

function parseEvidence(value: unknown): ParsedEvidence[] {
  if (!Array.isArray(value)) return [];
  const result: ParsedEvidence[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const path = entry["path"];
    if (typeof path !== "string" || path.length === 0) continue;
    result.push({
      path,
      startLine: nullableNum(entry["startLine"]),
      endLine: nullableNum(entry["endLine"]),
    });
  }
  return result;
}

function nullableNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
