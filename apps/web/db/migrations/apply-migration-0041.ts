#!/usr/bin/env tsx
// Apply migration 0041 (review_gate_outcomes side table) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0041.ts [--apply]
// Without --apply, prints the SQL and exits (dry run).
//
// The side table backs the Daybreak-inspired reachability + patch-verify
// stages. Schema is described in 0041_review_gate_outcomes.sql.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import * as dotenv from "dotenv";
import { assertSafeToApply, databaseHostForLog } from "./safety";

export { databaseHostForLog };

const selfPath = fileURLToPath(import.meta.url);
const selfDir = dirname(selfPath);

dotenv.config({ path: join(selfDir, "../../.env.local") });

const sqlFile = readFileSync(join(selfDir, "0041_review_gate_outcomes.sql"), "utf-8");

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
  query: (statement: string, params?: unknown[]) => Promise<SqlRow[]>;
};

export function migration0041Statements(sqlText = sqlFile): string[] {
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

export async function applyMigration0041(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0041Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql.query(stmt);
  }
}

export async function verifyMigration0041(sql: MigrationSql): Promise<{
  tablePresent: boolean;
  columns: string[];
  reviewIdx: boolean;
  stageVerdictIdx: boolean;
}> {
  const tableRows = await sql`
    SELECT 1 AS present
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'review_gate_outcomes'
  `;
  const columnRows = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'review_gate_outcomes'
    ORDER BY column_name
  `;
  const reviewIdxRows = await sql`
    SELECT 1 AS present
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'review_gate_outcomes_review_idx'
  `;
  const stageVerdictIdxRows = await sql`
    SELECT 1 AS present
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'review_gate_outcomes_stage_verdict_idx'
  `;
  return {
    tablePresent: tableRows.length > 0,
    columns: columnRows.map((r) => String(r["column_name"])),
    reviewIdx: reviewIdxRows.length > 0,
    stageVerdictIdx: stageVerdictIdxRows.length > 0,
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
  console.log("Applying migration 0041_review_gate_outcomes...");
  await applyMigration0041(sql);
  const verification = await verifyMigration0041(sql);

  console.log("Table present:", verification.tablePresent);
  console.log("Columns:", verification.columns.join(", "));
  console.log("review_idx present:", verification.reviewIdx);
  console.log("stage_verdict_idx present:", verification.stageVerdictIdx);

  const expectedColumns = [
    "created_at",
    "evidence",
    "finding_id",
    "id",
    "model_id",
    "review_id",
    "stage",
    "verdict",
  ];
  const missing = expectedColumns.filter((col) => !verification.columns.includes(col));
  if (
    !verification.tablePresent ||
    missing.length > 0 ||
    !verification.reviewIdx ||
    !verification.stageVerdictIdx
  ) {
    throw new Error(
      `Migration 0041 post-apply verification failed (table: ${verification.tablePresent}, missing columns: ${
        missing.join(", ") || "(none)"
      }, review_idx: ${verification.reviewIdx}, stage_verdict_idx: ${verification.stageVerdictIdx})`,
    );
  }
  console.log("Migration 0041 applied successfully.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
