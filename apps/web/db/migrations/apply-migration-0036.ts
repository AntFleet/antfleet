#!/usr/bin/env tsx
// Apply migration 0036 (review_jobs ACP rail columns) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0036.ts [--apply]

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import * as dotenv from "dotenv";

const selfPath = fileURLToPath(import.meta.url);
const selfDir = dirname(selfPath);

dotenv.config({ path: join(selfDir, "../../.env.local") });

const sqlFile = readFileSync(join(selfDir, "0036_review_jobs_acp.sql"), "utf-8");
const PROD_PATTERNS = ["neon-fulvous-zebra", "solitary-dew-96858656"];

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (statement: string): Promise<SqlRow[]>;
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
};

export function migration0036Statements(sqlText = sqlFile): string[] {
  const uncommented = sqlText
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  const statements: string[] = [];
  let current = "";
  for (const char of uncommented) {
    if (char === ";") {
      const statement = current.trim();
      if (statement.length > 0) statements.push(statement);
      current = "";
      continue;
    }
    current += char;
  }
  const statement = current.trim();
  if (statement.length > 0) statements.push(statement);
  return statements;
}

export async function applyMigration0036(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0036Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql(stmt);
  }
}

export async function verifyMigration0036(sql: MigrationSql): Promise<{
  columns: string[];
  indexes: string[];
  eventIndexes: string[];
  hasSubmitStatusConstraint: boolean;
  hasBudgetStatusConstraint: boolean;
  hasWalletConstraint: boolean;
  hasEventStatusConstraint: boolean;
}> {
  const columns = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'review_jobs'
      AND column_name IN (
        'acp_job_id',
        'acp_client_wallet',
        'acp_target_key',
        'acp_request_payload',
        'acp_review_id',
        'acp_budget_status',
        'acp_budget_response',
        'acp_budget_attempts',
        'acp_budget_updated_at',
        'acp_submit_status',
        'acp_submit_response',
        'acp_submitted_at'
      )
    ORDER BY column_name
  `;
  const indexes = await sql`
    SELECT indexname
    FROM pg_indexes
    WHERE tablename = 'review_jobs'
      AND indexname IN (
        'idx_review_jobs_acp_job_id_unique',
        'idx_review_jobs_acp_target_key_unique',
        'idx_review_jobs_acp_review_id',
        'idx_review_jobs_acp_budget_status',
        'idx_review_jobs_acp_submit_status'
      )
    ORDER BY indexname
  `;
  const eventIndexes = await sql`
    SELECT indexname
    FROM pg_indexes
    WHERE tablename = 'acp_provider_events'
      AND indexname IN (
        'idx_acp_provider_events_event_key_unique',
        'idx_acp_provider_events_status_next_retry',
        'idx_acp_provider_events_acp_job'
      )
    ORDER BY indexname
  `;
  const constraints = await sql`
    SELECT constraint_name
    FROM information_schema.table_constraints
    WHERE table_name IN ('review_jobs', 'acp_provider_events')
      AND constraint_name IN (
        'review_jobs_acp_submit_status_check',
        'review_jobs_acp_budget_status_check',
        'review_jobs_acp_wallet_check',
        'acp_provider_events_status_check'
      )
  `;
  const constraintNames = new Set(constraints.map((r) => String(r["constraint_name"])));
  return {
    columns: columns.map((r) => String(r["column_name"])),
    indexes: indexes.map((r) => String(r["indexname"])),
    eventIndexes: eventIndexes.map((r) => String(r["indexname"])),
    hasSubmitStatusConstraint: constraintNames.has("review_jobs_acp_submit_status_check"),
    hasBudgetStatusConstraint: constraintNames.has("review_jobs_acp_budget_status_check"),
    hasWalletConstraint: constraintNames.has("review_jobs_acp_wallet_check"),
    hasEventStatusConstraint: constraintNames.has("acp_provider_events_status_check"),
  };
}

export function databaseHostForLog(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function main() {
  const dryRun = !process.argv.includes("--apply");
  if (dryRun) {
    console.log("\n--- DRY RUN (pass --apply to execute) ---\n");
    console.log(sqlFile);
    return;
  }

  const url = process.env["DATABASE_URL"];
  if (!url) {
    console.error("DATABASE_URL not set");
    process.exitCode = 1;
    return;
  }

  const host = databaseHostForLog(url);
  console.log("Target host:", host);
  if (PROD_PATTERNS.some((p) => host.includes(p))) {
    console.error("REFUSING to run against prod-looking host:", host);
    process.exitCode = 1;
    return;
  }

  const sql = neon(url) as MigrationSql;
  console.log("Applying migration 0036_review_jobs_acp...");
  await applyMigration0036(sql);
  const verification = await verifyMigration0036(sql);
  console.log("Columns present:", verification.columns.join(", "));
  console.log("Indexes present:", verification.indexes.join(", "));
  console.log("ACP event indexes present:", verification.eventIndexes.join(", "));
  if (
    verification.columns.length !== 12 ||
    verification.indexes.length !== 5 ||
    verification.eventIndexes.length !== 3 ||
    !verification.hasSubmitStatusConstraint ||
    !verification.hasBudgetStatusConstraint ||
    !verification.hasWalletConstraint ||
    !verification.hasEventStatusConstraint
  ) {
    throw new Error("Migration 0036 post-apply verification failed");
  }
  console.log("Migration 0036 applied successfully.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
