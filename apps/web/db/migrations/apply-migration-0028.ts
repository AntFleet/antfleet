#!/usr/bin/env tsx
// Apply migration 0028 (review_jobs x402 columns) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0028.ts [--apply]
// Without --apply, prints the SQL and exits (dry run).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import * as dotenv from "dotenv";
import { assertSafeToApply } from "./safety";

const selfPath = fileURLToPath(import.meta.url);
const selfDir = dirname(selfPath);

dotenv.config({ path: join(selfDir, "../../.env.local") });

const sqlFile = readFileSync(join(selfDir, "0028_review_jobs_x402.sql"), "utf-8");

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
  query: (statement: string, params?: unknown[]) => Promise<SqlRow[]>;
};

export function migration0028Statements(sqlText = sqlFile): string[] {
  return sqlText
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function applyMigration0028(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0028Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql.query(stmt);
  }
}

export async function verifyMigration0028(sql: MigrationSql): Promise<{
  columns: string[];
  indexes: string[];
  hasSettlementConstraint: boolean;
  hasFailureModeConstraint: boolean;
}> {
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

  return {
    columns: columns.map((r) => String(r["column_name"])),
    indexes: indexes.map((r) => String(r["indexname"])),
    hasSettlementConstraint: settlementConstraints.length === 1,
    hasFailureModeConstraint: missingFailureModeConstraint.length > 0,
  };
}

async function main() {
  const { url, apply } = await assertSafeToApply();
  if (!apply) {
    console.log("\n--- DRY RUN (pass --apply to execute) ---\n");
    console.log(sqlFile);
    return;
  }

  const sql = neon(url) as MigrationSql;
  console.log("Applying migration 0028_review_jobs_x402...");
  await applyMigration0028(sql);
  const verification = await verifyMigration0028(sql);

  console.log("Columns present:", verification.columns.join(", "));
  console.log("Indexes present:", verification.indexes.join(", "));
  console.log(
    "review_jobs_x402_settlement_status_check present:",
    verification.hasSettlementConstraint ? "yes" : "no",
  );
  console.log(
    "review_jobs_failure_mode_check absent:",
    !verification.hasFailureModeConstraint ? "yes" : "no",
  );
  if (
    verification.columns.length !== 9 ||
    verification.indexes.length !== 6 ||
    !verification.hasSettlementConstraint ||
    verification.hasFailureModeConstraint
  ) {
    throw new Error("Migration 0028 post-apply verification failed");
  }
  console.log("Migration 0028 applied successfully.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
