#!/usr/bin/env tsx
// Apply migration 0028 (review_jobs x402 columns) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0028.ts [--apply]
// Without --apply, prints the SQL and exits (dry run).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import * as dotenv from "dotenv";

const selfPath = fileURLToPath(import.meta.url);
const selfDir = dirname(selfPath);

dotenv.config({ path: join(selfDir, "../../.env.local") });

const sqlFile = readFileSync(join(selfDir, "0028_review_jobs_x402.sql"), "utf-8");
const dryRun = !process.argv.includes("--apply");

if (dryRun) {
  console.log("\n--- DRY RUN (pass --apply to execute) ---\n");
  console.log(sqlFile);
  process.exit(0);
}

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const host = url.replace(/^postgresql:\/\/[^@]+@([^/?]+).*/, "$1");
console.log("Target host:", host);

const PROD_PATTERNS = ["neon-fulvous-zebra", "solitary-dew-96858656"];
if (PROD_PATTERNS.some((p) => host.includes(p))) {
  console.error("REFUSING to run against prod-looking host:", host);
  process.exit(1);
}

const sql = neon(url);

async function main() {
  console.log("Applying migration 0028_review_jobs_x402...");
  const statements = sqlFile
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql(stmt);
  }

  const columns = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'review_jobs'
      AND column_name IN (
        'caller_wallet',
        'payment_rail',
        'x402_pay_to',
        'x402_payment_payload',
        'x402_valid_after',
        'x402_valid_before',
        'x402_review_id',
        'x402_settlement_status',
        'x402_settlement_response'
      )
    ORDER BY column_name
  `;
  const missingFailureModeConstraint = await sql`
    SELECT constraint_name
    FROM information_schema.table_constraints
    WHERE table_name = 'review_jobs'
      AND constraint_name = 'review_jobs_failure_mode_check'
  `;
  const settlementConstraints = await sql`
    SELECT constraint_name
    FROM information_schema.table_constraints
    WHERE table_name = 'review_jobs'
      AND constraint_name = 'review_jobs_x402_settlement_status_check'
  `;
  const indexes = await sql`
    SELECT indexname
    FROM pg_indexes
    WHERE tablename = 'review_jobs'
      AND indexname IN (
        'idx_review_jobs_caller_wallet',
        'idx_review_jobs_payment_rail_created',
        'idx_review_jobs_rail_installation_idempotency_unique',
        'idx_review_jobs_x402_pay_to',
        'idx_review_jobs_x402_review_id',
        'idx_review_jobs_x402_settlement_status'
      )
    ORDER BY indexname
  `;

  console.log("Columns present:", columns.map((r) => r.column_name).join(", "));
  console.log("Indexes present:", indexes.map((r) => r.indexname).join(", "));
  console.log(
    "review_jobs_x402_settlement_status_check present:",
    settlementConstraints.length === 1 ? "yes" : "no",
  );
  console.log(
    "review_jobs_failure_mode_check absent:",
    missingFailureModeConstraint.length === 0 ? "yes" : "no",
  );
  if (columns.length !== 9 || indexes.length !== 6 || settlementConstraints.length !== 1) {
    throw new Error("Migration 0028 post-apply verification failed");
  }
  console.log("Migration 0028 applied successfully.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
