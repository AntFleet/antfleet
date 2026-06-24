#!/usr/bin/env tsx
// Apply migration 0046 (SARIF ingest token replay guard) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0046.ts [--apply]
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

const sqlFile = readFileSync(join(selfDir, "0046_sarif_ingest_token_use.sql"), "utf-8");

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
  query: (statement: string, params?: unknown[]) => Promise<SqlRow[]>;
};

export function migration0046Statements(sqlText = sqlFile): string[] {
  return splitSqlStatements(sqlText);
}

export async function applyMigration0046(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0046Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql.query(stmt);
  }
}

export async function verifyMigration0046(sql: MigrationSql): Promise<{
  tablePresent: boolean;
  usedAtIdx: boolean;
}> {
  const tableRows = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'sarif_ingest_token_use'
  `;
  const idxRows = await sql`
    SELECT 1 AS present FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'sarif_ingest_token_use_used_at_idx'
  `;
  return {
    tablePresent: tableRows.length > 0,
    usedAtIdx: idxRows.length > 0,
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
  console.log("Applying migration 0046_sarif_ingest_token_use...");
  await applyMigration0046(sql);
  const verification = await verifyMigration0046(sql);
  console.log("sarif_ingest_token_use present:", verification.tablePresent);
  console.log("sarif_ingest_token_use_used_at_idx present:", verification.usedAtIdx);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
