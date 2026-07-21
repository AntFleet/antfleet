#!/usr/bin/env tsx
// Apply migration 0055 (GLM shadow-judge replay tables) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0055.ts [--apply]
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

const sqlFile = readFileSync(join(selfDir, "0055_shadow_judge_runs.sql"), "utf-8");

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
  query: (statement: string, params?: unknown[]) => Promise<SqlRow[]>;
};

export function migration0055Statements(sqlText = sqlFile): string[] {
  return splitSqlStatements(sqlText);
}

export async function applyMigration0055(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0055Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql.query(stmt);
  }
}

export async function verifyMigration0055(sql: MigrationSql): Promise<{
  runsTable: boolean;
  labelsTable: boolean;
  cellUniqueIndex: boolean;
}> {
  const tableRows = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('shadow_judge_runs', 'shadow_judge_labels')
  `;
  const indexRows = await sql`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'shadow_judge_runs'
      AND indexname = 'shadow_judge_runs_cell_uniq'
  `;
  const names = tableRows.map((r) => r["table_name"]);
  return {
    runsTable: names.includes("shadow_judge_runs"),
    labelsTable: names.includes("shadow_judge_labels"),
    cellUniqueIndex: indexRows.length > 0,
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
  console.log("Applying migration 0055_shadow_judge_runs...");
  await applyMigration0055(sql);
  const verification = await verifyMigration0055(sql);
  console.log("shadow_judge_runs table present:", verification.runsTable);
  console.log("shadow_judge_labels table present:", verification.labelsTable);
  console.log("shadow_judge_runs_cell_uniq index present:", verification.cellUniqueIndex);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
