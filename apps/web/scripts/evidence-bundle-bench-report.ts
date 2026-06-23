#!/usr/bin/env tsx
// Read-only evidence-bundle report for AntFleet/bench-* reviews.
//
// This consumes persisted bundle rows from finding_validation_evidence_bundles
// and separately reports evidence that is derivable from review_gate_outcomes.
// It does not import or run the reachability gate or patch verifier.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import * as dotenv from "dotenv";

const selfPath = fileURLToPath(import.meta.url);
const selfDir = dirname(selfPath);
dotenv.config({ path: resolve(selfDir, "../.env.local") });

process.env["ANTFLEET_REACHABILITY_GATE"] = "true";
process.env["ANTFLEET_PATCH_VERIFY"] = "true";
process.env["ANTFLEET_EVIDENCE_BUNDLE"] = "true";

const RECENT_DAYS = 90;

type AgreedFinding = {
  reproduction: string | null;
};

type OutcomeRow = {
  id: string;
  stage: string;
  verdict: string;
  evidence: unknown;
  modelId: string | null;
  reviewAttempt: number;
  createdAt: Date;
};

type FindingRow = {
  reviewId: string;
  owner: string;
  repo: string;
  findingId: string;
  findingIndex: number;
  publicReceipt: boolean;
  status: string;
  closedAt: Date | null;
  retractedAt: Date | null;
  agreementDecision: unknown;
};

type BundleStatus = "complete" | "partial" | "empty";
type PersistedBundleStatus = BundleStatus | "unavailable";

type FindingReportRow = {
  owner: string;
  repo: string;
  findingId: string;
  persistedStatus: PersistedBundleStatus;
  derivableStatus: BundleStatus;
  pocSnippet: boolean;
  reproductionCommand: boolean;
  callPathTrace: boolean;
  publicReceiptEligible: boolean;
};

async function main(): Promise<void> {
  const { db } = await import("@/db");
  const { findingStatus, findingValidationEvidenceBundles, reviewGateOutcomes, reviews } =
    await import("@/db/schema");
  const { and, desc, eq, gte, sql } = await import("drizzle-orm");
  const tableProbe = await db.execute(sql`
    SELECT to_regclass('public.finding_validation_evidence_bundles') IS NOT NULL AS "present"
  `);
  const probeRows = (tableProbe as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
  const probeRow = probeRows[0];
  const bundleTablePresent = probeRow?.["present"] === true;

  const since = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      reviewId: reviews.reviewId,
      owner: reviews.owner,
      repo: reviews.repo,
      findingId: findingStatus.findingId,
      findingIndex: findingStatus.findingIndex,
      publicReceipt: reviews.publicReceipt,
      status: findingStatus.status,
      closedAt: findingStatus.closureDetectedAt,
      retractedAt: findingStatus.retractedAt,
      agreementDecision: reviews.agreementDecision,
    })
    .from(reviews)
    .innerJoin(findingStatus, eq(findingStatus.reviewId, reviews.reviewId))
    .where(
      and(
        eq(reviews.isBenchmark, true),
        gte(reviews.createdAt, since),
        sql`lower(${reviews.owner}) = 'antfleet'`,
        sql`${reviews.repo} LIKE 'bench-%'`,
      ),
    )
    .orderBy(desc(reviews.createdAt));

  const reportRows: FindingReportRow[] = [];
  for (const row of rows) {
    if (row.owner === null || row.repo === null) continue;
    const findingRow: FindingRow = {
      reviewId: row.reviewId,
      owner: row.owner,
      repo: row.repo,
      findingId: row.findingId,
      findingIndex: row.findingIndex,
      publicReceipt: row.publicReceipt,
      status: row.status,
      closedAt: row.closedAt,
      retractedAt: row.retractedAt,
      agreementDecision: row.agreementDecision,
    };
    const outcomes = await db
      .select({
        id: reviewGateOutcomes.id,
        stage: reviewGateOutcomes.stage,
        verdict: reviewGateOutcomes.verdict,
        evidence: reviewGateOutcomes.evidence,
        modelId: reviewGateOutcomes.modelId,
        reviewAttempt: reviewGateOutcomes.reviewAttempt,
        createdAt: reviewGateOutcomes.createdAt,
      })
      .from(reviewGateOutcomes)
      .where(
        and(
          eq(reviewGateOutcomes.reviewId, row.reviewId),
          eq(reviewGateOutcomes.findingId, row.findingId),
        ),
      )
      .orderBy(desc(reviewGateOutcomes.reviewAttempt), desc(reviewGateOutcomes.createdAt));

    const persisted = bundleTablePresent
      ? (
          await db
            .select({
              pocSnippet: findingValidationEvidenceBundles.pocSnippet,
              reproductionCommand: findingValidationEvidenceBundles.reproductionCommand,
              callPathTrace: findingValidationEvidenceBundles.callPathTrace,
            })
            .from(findingValidationEvidenceBundles)
            .where(
              and(
                eq(findingValidationEvidenceBundles.reviewId, row.reviewId),
                eq(findingValidationEvidenceBundles.findingId, row.findingId),
              ),
            )
            .orderBy(
              desc(findingValidationEvidenceBundles.reviewAttempt),
              desc(findingValidationEvidenceBundles.updatedAt),
            )
            .limit(1)
        )[0]
      : null;

    reportRows.push(classifyFinding(findingRow, outcomes, persisted, bundleTablePresent));
  }

  const reportPath = resolve(selfDir, "../../../.omc/research/evidence-bundle-bench-report.md");
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    renderReport({
      rows: reportRows,
      findingCount: rows.length,
      generatedAt: new Date(),
    }),
    "utf8",
  );
  console.log(`[evidence-bundle-report] wrote ${reportPath}`);
}

function classifyFinding(
  row: FindingRow,
  outcomes: OutcomeRow[],
  persisted:
    | {
        pocSnippet: unknown;
        reproductionCommand: unknown;
        callPathTrace: unknown;
      }
    | null
    | undefined,
  bundleTablePresent: boolean,
): FindingReportRow {
  const agreed = extractAgreed(row.agreementDecision);
  const finding = agreed[row.findingIndex];
  const patchVerify = outcomes.find((o) => o.stage === "patch_verify");
  const reachability = outcomes.find((o) => o.stage === "reachability");
  const derivableReproduction = hasPatchVerifyCommand(patchVerify?.evidence);
  const pocSnippet =
    derivableReproduction &&
    typeof finding?.reproduction === "string" &&
    finding.reproduction.trim().length > 0;
  const derivableCallPath = hasReachabilityCallPath(reachability?.evidence);
  const derivableStatus = statusFromCount(
    [pocSnippet, derivableReproduction, derivableCallPath].filter(Boolean).length,
  );
  const persistedSlotCount =
    persisted === null || persisted === undefined
      ? 0
      : [
          slotText(persisted.pocSnippet, "text"),
          slotText(persisted.reproductionCommand, "command"),
          hasRenderableCallPath(persisted.callPathTrace) ? "present" : null,
        ].filter((value) => value !== null).length;
  const persistedStatus: PersistedBundleStatus = bundleTablePresent
    ? statusFromCount(persistedSlotCount)
    : "unavailable";
  return {
    owner: row.owner,
    repo: row.repo,
    findingId: row.findingId,
    persistedStatus,
    derivableStatus,
    pocSnippet: persistedSlotCount > 0 && slotText(persisted?.pocSnippet, "text") !== null,
    reproductionCommand:
      persistedSlotCount > 0 && slotText(persisted?.reproductionCommand, "command") !== null,
    callPathTrace: persistedSlotCount > 0 && hasRenderableCallPath(persisted?.callPathTrace),
    publicReceiptEligible:
      row.publicReceipt &&
      row.status === "closed" &&
      row.closedAt !== null &&
      row.retractedAt === null,
  };
}

function statusFromCount(slotCount: number): BundleStatus {
  if (slotCount === 3) return "complete";
  if (slotCount > 0) return "partial";
  return "empty";
}

function extractAgreed(agreementDecision: unknown): AgreedFinding[] {
  if (agreementDecision === null || typeof agreementDecision !== "object") return [];
  const agreed = (agreementDecision as Record<string, unknown>)["agreed"];
  if (!Array.isArray(agreed)) return [];
  return agreed.map((item) => {
    if (item === null || typeof item !== "object") return { reproduction: null };
    const reproduction = (item as Record<string, unknown>)["reproduction"];
    return { reproduction: typeof reproduction === "string" ? reproduction : null };
  });
}

function hasPatchVerifyCommand(evidence: unknown): boolean {
  const record = asRecord(evidence);
  if (record === null) return false;
  const pocCmd = record["pocCmd"];
  return typeof pocCmd === "string" && pocCmd.trim().length > 0;
}

function hasReachabilityCallPath(evidence: unknown): boolean {
  const record = asRecord(evidence);
  if (record === null) return false;
  if (record["entryPoint"] === null || record["entryPoint"] === undefined) return false;
  const callPath = record["callPath"];
  return Array.isArray(callPath) && callPath.length > 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function slotText(slot: unknown, key: string): string | null {
  const slotRecord = asRecord(slot);
  const value = asRecord(slotRecord?.["value"]);
  const text = value?.[key];
  return typeof text === "string" && text.trim().length > 0 ? text : null;
}

function hasRenderableCallPath(slot: unknown): boolean {
  const slotRecord = asRecord(slot);
  const value = asRecord(slotRecord?.["value"]);
  if (value === null) return false;
  const entry = asRecord(value["entryPoint"]);
  const callPath = value["callPath"];
  return entry !== null && Array.isArray(callPath) && callPath.length > 0;
}

function renderReport(args: {
  rows: FindingReportRow[];
  findingCount: number;
  generatedAt: Date;
}): string {
  const byRepo = new Map<
    string,
    {
      complete: number;
      partial: number;
      empty: number;
      unavailable: number;
      derivableComplete: number;
      findings: number;
    }
  >();
  for (const row of args.rows) {
    const key = `${row.owner}/${row.repo}`;
    const tally = byRepo.get(key) ?? {
      complete: 0,
      partial: 0,
      empty: 0,
      unavailable: 0,
      derivableComplete: 0,
      findings: 0,
    };
    tally[row.persistedStatus]++;
    if (row.derivableStatus === "complete") tally.derivableComplete++;
    tally.findings++;
    byRepo.set(key, tally);
  }

  const total = [...byRepo.values()].reduce(
    (acc, row) => ({
      complete: acc.complete + row.complete,
      partial: acc.partial + row.partial,
      empty: acc.empty + row.empty,
      unavailable: acc.unavailable + row.unavailable,
      derivableComplete: acc.derivableComplete + row.derivableComplete,
      findings: acc.findings + row.findings,
    }),
    { complete: 0, partial: 0, empty: 0, unavailable: 0, derivableComplete: 0, findings: 0 },
  );

  const repoLines = [...byRepo.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(
      ([repo, tally]) =>
        `| ${repo} | ${tally.findings} | ${tally.complete} | ${tally.partial} | ${tally.empty} | ${tally.unavailable} | ${tally.derivableComplete} |`,
    )
    .join("\n");

  const completeReceipt = args.rows.find(
    (row) => row.persistedStatus === "complete" && row.publicReceiptEligible,
  );
  return `# Evidence Bundle Bench Report

Generated: ${args.generatedAt.toISOString()}

Source: persisted \`finding_validation_evidence_bundles\` for \`AntFleet/bench-*\` benchmark findings from the last ${RECENT_DAYS} days. Derivable gate-output coverage is reported separately from persisted bundle coverage.

Flags set in-process for this read-only report:
- \`ANTFLEET_REACHABILITY_GATE=true\`
- \`ANTFLEET_PATCH_VERIFY=true\`
- \`ANTFLEET_EVIDENCE_BUNDLE=true\`

No reachability or patch-verification work was recomputed.

| Repo | findings | persisted complete | persisted partial | persisted empty | persisted unavailable | derivable complete |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${repoLines || "| _none_ | 0 | 0 | 0 | 0 | 0 | 0 |"}
| **total** | **${total.findings}** | **${total.complete}** | **${total.partial}** | **${total.empty}** | **${total.unavailable}** | **${total.derivableComplete}** |

Complete public receipt candidate: ${
    completeReceipt === undefined
      ? "_none found in persisted public-eligible bundle rows_"
      : `https://www.antfleet.dev/receipts/${completeReceipt.findingId}`
  }

Notes:
- Persisted complete means all three renderable slots are present in \`finding_validation_evidence_bundles\`: public PoC text, reproduction command, and reachability \`entryPoint + callPath\`.
- Derivable complete means stored \`review_gate_outcomes\` contain enough data to build all three slots, but does not prove the evidence bundle writer/table path succeeded.
- Partial means one or two slots are present.
- Empty means the persisted bundle row has no renderable evidence slots.
- Unavailable means migration 0042 is not applied in the queried database, so persisted bundle coverage could not be read.
- This report reads stored database outputs only because this session was constrained not to recompute #2 or #5.
`;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
