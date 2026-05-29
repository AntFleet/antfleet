#!/usr/bin/env tsx
// Seed SPEC-001 AC-12 review-level receipt fixtures.
// Usage:
//   pnpm exec tsx db/seed/x402-receipt-test-fixtures.ts --help
//   X402_FIXTURE_SHA=<pr-1-head-sha> pnpm exec tsx db/seed/x402-receipt-test-fixtures.ts --apply

import { neon } from "@neondatabase/serverless";
import { createHash } from "node:crypto";
import * as dotenv from "dotenv";

dotenv.config({ path: new URL("../../.env.local", import.meta.url).pathname });

const help = process.argv.includes("--help");
const apply = process.argv.includes("--apply");

if (help || !apply) {
  console.log(`Seed x402 receipt fixtures for SPEC-001 AC-12.

Options:
  --help    Show this help
  --apply   Insert or update fixture rows

Required env for --apply:
  DATABASE_URL
  X402_FIXTURE_SHA   Head SHA for antfleet/x402-fixture PR #1
`);
  process.exit(0);
}

const url = process.env["DATABASE_URL"];
const sha = process.env["X402_FIXTURE_SHA"];
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
if (!sha) {
  console.error("X402_FIXTURE_SHA not set");
  process.exit(1);
}

const sql = neon(url);
const now = new Date().toISOString();
const fixtureRepoHash = createHash("sha256").update("antfleet/x402-fixture").digest("hex");

async function main() {
  const reviewIds = [
    "x402-ac12-complete-two-findings",
    "x402-ac12-complete-zero-findings",
    "x402-ac12-failed-provider-error",
  ];

  for (const reviewId of reviewIds) {
    await sql`
      INSERT INTO reviews (
        review_id, repo_hash, pr_number, commit_sha, files_reviewed,
        prompt_version, provider_model_ids, provider_responses,
        agreement_decision, timing_ms, cost_estimated_usd, schema_version,
        installation_id, owner, repo, public_receipt, is_benchmark,
        processing_status, processing_attempts, processing_finished_at
      ) VALUES (
        ${reviewId}, ${fixtureRepoHash}, 1, ${sha},
        ARRAY['src/math.ts'], 'spike-v1',
        '{"anthropic":"fixture","openai":"fixture"}'::jsonb,
        '{"status":"fixture"}'::jsonb,
        '{"mode":"unanimous","agreed":[],"disagreements":[],"degraded":false}'::jsonb,
        1200, '0.0500', 1, NULL, 'antfleet', 'x402-fixture', true, false,
        'done', 1, ${now}
      )
      ON CONFLICT (review_id) DO UPDATE SET
        commit_sha = EXCLUDED.commit_sha,
        public_receipt = true,
        processing_status = EXCLUDED.processing_status
    `;
  }

  await sql`
    INSERT INTO finding_status (review_id, finding_index, finding_id, title, severity, category)
    VALUES
      (${reviewIds[0]}, 0, 'x402-ac12-0', 'Fixture high finding', 'high', 'correctness'),
      (${reviewIds[0]}, 1, 'x402-ac12-1', 'Fixture medium finding', 'medium', 'security')
    ON CONFLICT (finding_id) DO UPDATE SET
      title = EXCLUDED.title,
      severity = EXCLUDED.severity,
      category = EXCLUDED.category
  `;

  for (const [jobId, reviewId, status, failureMode, settlementStatus] of [
    ["x402-ac12-job-two-findings", reviewIds[0], "complete", null, "settled"],
    ["x402-ac12-job-zero-findings", reviewIds[1], "complete", null, "settled"],
    ["x402-ac12-job-provider-error", reviewIds[2], "failed", "provider_error", "not_settled"],
  ] as const) {
    await sql`
      INSERT INTO review_jobs (
        job_id, installation_id, wallet_address, repo_owner, repo_name,
        pr_number, sha, idempotency_key, status, failure_mode, failure_message,
        result, caller_wallet, payment_rail, x402_pay_to, x402_review_id,
        x402_settlement_status, expires_at
      ) VALUES (
        ${jobId}, 'x402', '0x0000000000000000000000000000000000000001',
        'antfleet', 'x402-fixture', 1, ${sha}, ${jobId}, ${status},
        ${failureMode}, ${failureMode === null ? null : "The review provider returned an error."},
        ${JSON.stringify({ reviewId, paid_via: "x402", receipt_url: `/receipts/review/${reviewId}` })}::jsonb,
        '0x0000000000000000000000000000000000000001', 'x402',
        '0x0000000000000000000000000000000000000002', ${reviewId},
        ${settlementStatus},
        now() + INTERVAL '24 hours'
      )
      ON CONFLICT (job_id) DO UPDATE SET
        sha = EXCLUDED.sha,
        status = EXCLUDED.status,
        failure_mode = EXCLUDED.failure_mode,
        result = EXCLUDED.result,
        x402_review_id = EXCLUDED.x402_review_id,
        x402_settlement_status = EXCLUDED.x402_settlement_status
    `;
  }

  console.log("Seeded SPEC-001 AC-12 x402 receipt fixtures.");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
