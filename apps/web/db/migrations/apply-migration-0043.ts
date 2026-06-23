#!/usr/bin/env tsx
// Apply migration 0043 (repo threat model side table) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0043.ts [--apply]
// Without --apply, prints the SQL and exits (dry run).

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

const sqlFile = readFileSync(join(selfDir, "0043_repo_threat_model.sql"), "utf-8");

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
  query: (statement: string, params?: unknown[]) => Promise<SqlRow[]>;
};

export function migration0043Statements(sqlText = sqlFile): string[] {
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

export async function applyMigration0043(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0043Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql.query(stmt);
  }
}

export async function verifyMigration0043(sql: MigrationSql): Promise<{
  tablePresent: boolean;
  columns: string[];
  ownerRepoIdx: boolean;
  publicAccessIdx: boolean;
}> {
  const tableRows = await sql`
    SELECT 1 AS present
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'repo_threat_model'
  `;
  const columnRows = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'repo_threat_model'
    ORDER BY column_name
  `;
  const ownerRepoRows = await sql`
    SELECT 1 AS present
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'repo_threat_model_owner_repo_idx'
  `;
  const publicAccessRows = await sql`
    SELECT 1 AS present
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'repo_threat_model_public_access_idx'
  `;
  return {
    tablePresent: tableRows.length > 0,
    columns: columnRows.map((r) => String(r["column_name"])),
    ownerRepoIdx: ownerRepoRows.length > 0,
    publicAccessIdx: publicAccessRows.length > 0,
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
  console.log("Applying migration 0043_repo_threat_model...");
  await applyMigration0043(sql);
  const verification = await verifyMigration0043(sql);

  console.log("Table present:", verification.tablePresent);
  console.log("Columns:", verification.columns.join(", "));
  console.log("owner_repo_idx present:", verification.ownerRepoIdx);
  console.log("public_access_idx present:", verification.publicAccessIdx);

  const expectedColumns = [
    "created_at",
    "critical_assets_refreshed_sha",
    "entry_points_refreshed_sha",
    "generator_model_id",
    "id",
    "last_reviewed_sha",
    "model",
    "owner",
    "provenance",
    "public_access",
    "public_model",
    "refresh_count",
    "repo",
    "repo_hash",
    "secrets_surface_refreshed_sha",
    "sinks_refreshed_sha",
    "trust_boundaries_refreshed_sha",
    "updated_at",
    "version",
  ];
  const missing = expectedColumns.filter((col) => !verification.columns.includes(col));
  if (
    !verification.tablePresent ||
    missing.length > 0 ||
    !verification.ownerRepoIdx ||
    !verification.publicAccessIdx
  ) {
    throw new Error(`Migration 0043 verification failed; missing=${missing.join(",") || "none"}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
