#!/usr/bin/env tsx
// Apply migration 0045 (SARIF ingest/export side tables) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0045.ts [--apply]
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

const sqlFile = readFileSync(join(selfDir, "0045_sarif_ingest_export.sql"), "utf-8");

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
  query: (statement: string, params?: unknown[]) => Promise<SqlRow[]>;
};

export function migration0045Statements(sqlText = sqlFile): string[] {
  return splitSqlStatements(sqlText);
}

export async function applyMigration0045(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0045Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql.query(stmt);
  }
}

export async function verifyMigration0045(sql: MigrationSql): Promise<{
  batchPresent: boolean;
  findingPresent: boolean;
  batchRepoIdx: boolean;
  findingFingerprintIdx: boolean;
}> {
  const tableRows = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('sarif_import_batch', 'sarif_finding')
  `;
  const batchRepoIdxRows = await sql`
    SELECT 1 AS present FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'sarif_import_batch_repo_idx'
  `;
  const findingFingerprintIdxRows = await sql`
    SELECT 1 AS present FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'sarif_finding_batch_fingerprint_uniq'
  `;
  const tables = new Set(tableRows.map((r) => String(r["table_name"])));
  return {
    batchPresent: tables.has("sarif_import_batch"),
    findingPresent: tables.has("sarif_finding"),
    batchRepoIdx: batchRepoIdxRows.length > 0,
    findingFingerprintIdx: findingFingerprintIdxRows.length > 0,
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
  console.log("Applying migration 0045_sarif_ingest_export...");
  await applyMigration0045(sql);
  const verification = await verifyMigration0045(sql);
  console.log("sarif_import_batch present:", verification.batchPresent);
  console.log("sarif_finding present:", verification.findingPresent);
  console.log("sarif_import_batch_repo_idx present:", verification.batchRepoIdx);
  console.log("sarif_finding_batch_fingerprint_uniq present:", verification.findingFingerprintIdx);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
