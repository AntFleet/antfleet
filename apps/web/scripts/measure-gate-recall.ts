/**
 * One-shot diagnostic: measure how aggressive the postability gate (two-model
 * unanimous agreement) is. Every finding both models flag is "agreed" (posted);
 * a finding only one model flags is a "disagreement" (blocked). We want the
 * gate pass rate — agreed / (agreed + disagreements) — sliced by severity,
 * category, and which provider accounts for the single-sided findings, so we
 * can tell whether the gate is silently killing real findings.
 *
 * Source data: reviews.agreement_decision JSONB, written by review-worker.ts.
 * Its shape at rest is { mode, agreed: Finding[], disagreements: Disagreement[],
 * degraded, degradedReason } — except no-file reviews store { status: "skipped" },
 * which we skip. Reads the last 200 done reviews via the Drizzle client.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/measure-gate-recall.ts
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

// Import AFTER dotenv: @/db throws at module load if DATABASE_URL is unset.
const { db, schema } = await import("@/db");
const { desc, eq } = await import("drizzle-orm");

import type { Disagreement, Finding } from "@/lib/review-types";

// The persisted agreement_decision is either the full bundle or a skip marker.
type AgreementDecisionAtRest =
  | {
      mode?: string;
      agreed?: Finding[];
      disagreements?: Disagreement[];
      degraded?: boolean;
      degradedReason?: string | null;
    }
  | { status: "skipped" };

function isSkipped(d: AgreementDecisionAtRest): d is { status: "skipped" } {
  return "status" in d && d.status === "skipped";
}

const rows = await db
  .select({
    reviewId: schema.reviews.reviewId,
    agreementDecision: schema.reviews.agreementDecision,
  })
  .from(schema.reviews)
  .where(eq(schema.reviews.processingStatus, "done"))
  .orderBy(desc(schema.reviews.createdAt))
  .limit(200);

let reviewsConsidered = 0;
let reviewsSkipped = 0;
let totalAgreed = 0;
let totalDisagreements = 0;

const bySeverity: Record<string, number> = {};
const byCategory: Record<string, number> = {};
const byProviderSet: Record<string, number> = {};
let policyReviewInDisagreements = 0;
let upstreamOriginInDisagreements = 0;
// Same two flags counted within agreed (posted) findings — the symmetric
// denominator. Together with the disagreement counts they answer "how often
// do the models raise these flags at all", not just "within blocked findings".
let policyReviewInAgreed = 0;
let upstreamOriginInAgreed = 0;

const bump = (table: Record<string, number>, key: string): void => {
  table[key] = (table[key] ?? 0) + 1;
};

const hasUpstreamOrigin = (f: Finding): boolean =>
  f.upstreamOrigin !== undefined && f.upstreamOrigin !== null;

for (const row of rows) {
  const decision = row.agreementDecision as AgreementDecisionAtRest | null;
  if (decision === null || isSkipped(decision)) {
    reviewsSkipped++;
    continue;
  }
  const agreed = Array.isArray(decision.agreed) ? decision.agreed : [];
  const disagreements = Array.isArray(decision.disagreements) ? decision.disagreements : [];

  reviewsConsidered++;
  totalAgreed += agreed.length;
  totalDisagreements += disagreements.length;

  for (const finding of agreed) {
    if (finding === undefined || finding === null) continue;
    // New v1.5 flags — 0 for reviews stored before the fields shipped.
    if (finding.requiresPolicyReview === true) policyReviewInAgreed++;
    if (hasUpstreamOrigin(finding)) upstreamOriginInAgreed++;
  }

  for (const d of disagreements) {
    const finding = d.finding;
    if (finding !== undefined && finding !== null) {
      bump(bySeverity, finding.severity ?? "unknown");
      bump(byCategory, finding.category ?? "unknown");
      // New v1.5 flags — 0 for reviews stored before the fields shipped.
      if (finding.requiresPolicyReview === true) policyReviewInDisagreements++;
      if (hasUpstreamOrigin(finding)) upstreamOriginInDisagreements++;
    }
    // providers is the set that flagged this single-sided cluster — in
    // unanimous mode it is usually one name ("anthropic" / "openai").
    const providerKey = Array.isArray(d.providers) ? d.providers.toSorted().join("+") : "unknown";
    bump(byProviderSet, providerKey);
  }
}

const totalEmitted = totalAgreed + totalDisagreements;
const passRate = totalEmitted === 0 ? 0 : totalAgreed / totalEmitted;
const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);

const sortDesc = (table: Record<string, number>): Array<[string, number]> =>
  Object.entries(table).toSorted((a, b) => b[1] - a[1]);

console.log("=".repeat(60));
console.log("Postability gate recall diagnostic");
console.log("=".repeat(60));
console.log(`Reviews scanned (done, newest 200): ${rows.length}`);
console.log(`  with a decision bundle:            ${reviewsConsidered}`);
console.log(`  skipped (no decision / no files):  ${reviewsSkipped}`);
console.log("");
console.log("Overall gate pass rate");
console.log(`  agreed (posted):       ${totalAgreed}`);
console.log(`  disagreements (blocked): ${totalDisagreements}`);
console.log(`  total emitted:         ${totalEmitted}`);
console.log(`  pass rate:             ${(passRate * 100).toFixed(1)}%  (agreed / total emitted)`);
console.log("");
console.log("Disagreements by severity (blocked findings)");
for (const sev of ["critical", "high", "medium", "low"]) {
  const n = bySeverity[sev] ?? 0;
  console.log(`  ${sev.padEnd(9)} ${String(n).padStart(5)}  ${pct(n, totalDisagreements)}`);
}
const otherSev = sortDesc(bySeverity).filter(
  ([k]) => !["critical", "high", "medium", "low"].includes(k),
);
for (const [sev, n] of otherSev) {
  console.log(`  ${sev.padEnd(9)} ${String(n).padStart(5)}  ${pct(n, totalDisagreements)}`);
}
console.log("");
console.log("Top blocked categories");
for (const [cat, n] of sortDesc(byCategory).slice(0, 5)) {
  console.log(`  ${cat.padEnd(16)} ${String(n).padStart(5)}  ${pct(n, totalDisagreements)}`);
}
console.log("");
console.log("Single-provider breakdown (who flagged the blocked findings)");
for (const [key, n] of sortDesc(byProviderSet)) {
  console.log(`  ${key.padEnd(20)} ${String(n).padStart(5)}  ${pct(n, totalDisagreements)}`);
}
console.log("");
console.log("New-flag prevalence (0 for pre-flag reviews)");
console.log(
  `  requiresPolicyReview=true  agreed: ${policyReviewInAgreed} ${pct(policyReviewInAgreed, totalAgreed)}   blocked: ${policyReviewInDisagreements} ${pct(policyReviewInDisagreements, totalDisagreements)}`,
);
console.log(
  `  upstreamOrigin!=null       agreed: ${upstreamOriginInAgreed} ${pct(upstreamOriginInAgreed, totalAgreed)}   blocked: ${upstreamOriginInDisagreements} ${pct(upstreamOriginInDisagreements, totalDisagreements)}`,
);

process.exit(0);
