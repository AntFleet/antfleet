#!/usr/bin/env tsx
// Apply migration 0048 (repo cyber tier — side table + audit log) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0048.ts [--apply]
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

const sqlFile = readFileSync(join(selfDir, "0048_repo_cyber_tier.sql"), "utf-8");

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
  query: (statement: string, params?: unknown[]) => Promise<SqlRow[]>;
};

export function migration0048Statements(sqlText = sqlFile): string[] {
  return splitSqlStatements(sqlText);
}

export async function applyMigration0048(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0048Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql.query(stmt);
  }
}

export async function verifyMigration0048(sql: MigrationSql): Promise<{
  cyberTierType: boolean;
  repoTierTable: boolean;
  repoTierTierIdx: boolean;
  changeLogTable: boolean;
  changeLogRepoIdx: boolean;
  changeLogChangedAtIdx: boolean;
  reasonCheck: boolean;
}> {
  const typeRows = await sql`
    SELECT 1 AS present FROM pg_type WHERE typname = 'cyber_tier'
  `;
  const repoTierRows = await sql`
    SELECT 1 AS present FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'repo_tier'
  `;
  const repoTierIdxRows = await sql`
    SELECT 1 AS present FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'repo_tier_tier_idx'
  `;
  const changeLogRows = await sql`
    SELECT 1 AS present FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'repo_tier_change_log'
  `;
  const changeLogIdxRows = await sql`
    SELECT 1 AS present FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'repo_tier_change_log_repo_idx'
  `;
  const changeLogChangedAtIdxRows = await sql`
    SELECT 1 AS present FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'repo_tier_change_log_changed_at_idx'
  `;
  const checkRows = await sql`
    SELECT 1 AS present FROM information_schema.check_constraints
    WHERE constraint_schema = 'public'
      AND constraint_name = 'repo_tier_change_log_reason_length_check'
  `;
  return {
    cyberTierType: typeRows.length > 0,
    repoTierTable: repoTierRows.length > 0,
    repoTierTierIdx: repoTierIdxRows.length > 0,
    changeLogTable: changeLogRows.length > 0,
    changeLogRepoIdx: changeLogIdxRows.length > 0,
    changeLogChangedAtIdx: changeLogChangedAtIdxRows.length > 0,
    reasonCheck: checkRows.length > 0,
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
  console.log("Applying migration 0048_repo_cyber_tier...");
  await applyMigration0048(sql);
  const verification = await verifyMigration0048(sql);
  console.log("cyber_tier type present:", verification.cyberTierType);
  console.log("repo_tier table present:", verification.repoTierTable);
  console.log("repo_tier_tier_idx present:", verification.repoTierTierIdx);
  console.log("repo_tier_change_log table present:", verification.changeLogTable);
  console.log("repo_tier_change_log_repo_idx present:", verification.changeLogRepoIdx);
  console.log("repo_tier_change_log_changed_at_idx present:", verification.changeLogChangedAtIdx);
  console.log("reason length CHECK present:", verification.reasonCheck);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
