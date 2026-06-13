#!/usr/bin/env tsx
// Apply migration 0040 (processing-queue column reconciliation) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0040.ts [--apply]
// Without --apply, prints the SQL and exits (dry run).
//
// Promotes the retired apps/web/scripts/_apply-missing-cols.ts one-off into
// the standard apply-migration runner pattern (T3.6 audit cleanup). Prod was
// reconciled on 2026-06-13 via the retired script; this runner exists so any
// future environment can be brought to the same state.

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

const sqlFile = readFileSync(join(selfDir, "0040_processing_queue_reconcile.sql"), "utf-8");

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
  query: (statement: string, params?: unknown[]) => Promise<SqlRow[]>;
};

export function migration0040Statements(sqlText = sqlFile): string[] {
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

export async function applyMigration0040(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0040Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql.query(stmt);
  }
}

export async function verifyMigration0040(sql: MigrationSql): Promise<{
  columns: string[];
  constraint: boolean;
  index: boolean;
}> {
  const columnRows = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'reviews'
      AND column_name IN (
        'processing_status',
        'processing_attempts',
        'processing_started_at',
        'processing_finished_at',
        'next_retry_at',
        'processing_error'
      )
    ORDER BY column_name
  `;
  const columns = columnRows.map((r) => String(r["column_name"]));

  const constraintRows = await sql`
    SELECT 1 AS present
    FROM pg_constraint
    WHERE conname = 'reviews_idempotency_uniq'
  `;
  const indexRows = await sql`
    SELECT 1 AS present
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'reviews_processing_lookup_idx'
  `;

  return {
    columns,
    constraint: constraintRows.length > 0,
    index: indexRows.length > 0,
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
  console.log("Applying migration 0040_processing_queue_reconcile...");
  await applyMigration0040(sql);
  const verification = await verifyMigration0040(sql);

  console.log("Columns present:", verification.columns.join(", "));
  console.log("reviews_idempotency_uniq constraint present:", verification.constraint);
  console.log("reviews_processing_lookup_idx index present:", verification.index);

  const expectedColumns = [
    "next_retry_at",
    "processing_attempts",
    "processing_error",
    "processing_finished_at",
    "processing_started_at",
    "processing_status",
  ];
  const missing = expectedColumns.filter((col) => !verification.columns.includes(col));
  if (missing.length > 0 || !verification.constraint || !verification.index) {
    throw new Error(
      `Migration 0040 post-apply verification failed (missing columns: ${
        missing.join(", ") || "(none)"
      }, constraint: ${verification.constraint}, index: ${verification.index})`,
    );
  }
  console.log("Migration 0040 applied successfully.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
