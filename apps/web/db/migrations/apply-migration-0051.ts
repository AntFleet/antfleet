#!/usr/bin/env tsx
// Apply migration 0051 (single-model shadow tier columns) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0051.ts [--apply]
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

const sqlFile = readFileSync(join(selfDir, "0051_single_model_tier.sql"), "utf-8");

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
  query: (statement: string, params?: unknown[]) => Promise<SqlRow[]>;
};

export function migration0051Statements(sqlText = sqlFile): string[] {
  return splitSqlStatements(sqlText);
}

export async function applyMigration0051(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0051Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql.query(stmt);
  }
}

export async function verifyMigration0051(sql: MigrationSql): Promise<{
  findingStatusSourceColumn: boolean;
  singleModelTierEnabledColumn: boolean;
}> {
  const sourceRows = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'finding_status'
      AND column_name = 'source'
  `;
  const installRows = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'installations'
      AND column_name = 'single_model_tier_enabled'
  `;
  return {
    findingStatusSourceColumn: sourceRows.length > 0,
    singleModelTierEnabledColumn: installRows.length > 0,
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
  console.log("Applying migration 0051_single_model_tier...");
  await applyMigration0051(sql);
  const verification = await verifyMigration0051(sql);
  console.log("finding_status.source column present:", verification.findingStatusSourceColumn);
  console.log(
    "installations.single_model_tier_enabled column present:",
    verification.singleModelTierEnabledColumn,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
