#!/usr/bin/env tsx
// Apply migration 0050 (installations precision_feedback_enabled column) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0050.ts [--apply]
// Without --apply, prints the SQL and exits (dry run).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import * as dotenv from "dotenv";
import { assertSafeToApply, splitSqlStatements } from "./safety";

const selfPath = fileURLToPath(import.meta.url);
const selfDir = dirname(selfPath);

dotenv.config({ path: join(selfDir, "../../.env.local") });

const sqlFile = readFileSync(
  join(selfDir, "0050_installations_precision_feedback.sql"),
  "utf-8",
);

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
  query: (statement: string, params?: unknown[]) => Promise<SqlRow[]>;
};

export function migration0050Statements(sqlText = sqlFile): string[] {
  return splitSqlStatements(sqlText);
}

export async function applyMigration0050(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0050Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql.query(stmt);
  }
}

export async function verifyMigration0050(sql: MigrationSql): Promise<{
  precisionFeedbackEnabledColumn: boolean;
}> {
  const colRows = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'installations'
      AND column_name = 'precision_feedback_enabled'
  `;
  return {
    precisionFeedbackEnabledColumn: colRows.length > 0,
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
  console.log("Applying migration 0050_installations_precision_feedback...");
  await applyMigration0050(sql);
  const verification = await verifyMigration0050(sql);
  console.log(
    "installations.precision_feedback_enabled column present:",
    verification.precisionFeedbackEnabledColumn,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
