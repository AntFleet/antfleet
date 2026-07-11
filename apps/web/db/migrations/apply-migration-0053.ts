#!/usr/bin/env tsx
// Apply migration 0053 (repro_verify side-table idempotency index) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0053.ts [--apply]
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

const sqlFile = readFileSync(join(selfDir, "0053_repro_verify_idempotency.sql"), "utf-8");

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
  query: (statement: string, params?: unknown[]) => Promise<SqlRow[]>;
};

export function migration0053Statements(sqlText = sqlFile): string[] {
  return splitSqlStatements(sqlText);
}

export async function applyMigration0053(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0053Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql.query(stmt);
  }
}

export async function verifyMigration0053(sql: MigrationSql): Promise<{
  reproVerifyUniqueIndex: boolean;
}> {
  const indexRows = await sql`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'review_gate_outcomes'
      AND indexname = 'review_gate_outcomes_repro_verify_uniq'
  `;
  return {
    reproVerifyUniqueIndex: indexRows.length > 0,
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
  console.log("Applying migration 0053_repro_verify_idempotency...");
  await applyMigration0053(sql);
  const verification = await verifyMigration0053(sql);
  console.log(
    "review_gate_outcomes_repro_verify_uniq index present:",
    verification.reproVerifyUniqueIndex,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
