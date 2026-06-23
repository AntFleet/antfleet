#!/usr/bin/env tsx
// Apply migration 0042 (finding validation evidence bundles) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0042.ts [--apply]
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

const sqlFile = readFileSync(
  join(selfDir, "0042_finding_validation_evidence_bundles.sql"),
  "utf-8",
);

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
  query: (statement: string, params?: unknown[]) => Promise<SqlRow[]>;
};

export function migration0042Statements(sqlText = sqlFile): string[] {
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

export async function applyMigration0042(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0042Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql.query(stmt);
  }
}

export async function verifyMigration0042(sql: MigrationSql): Promise<{
  tablePresent: boolean;
  columns: string[];
  findingIdx: boolean;
  statusIdx: boolean;
  uniqueConstraint: boolean;
}> {
  const tableRows = await sql`
    SELECT 1 AS present
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'finding_validation_evidence_bundles'
  `;
  const columnRows = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'finding_validation_evidence_bundles'
    ORDER BY column_name
  `;
  const findingIdxRows = await sql`
    SELECT 1 AS present
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'finding_validation_evidence_bundle_finding_idx'
  `;
  const statusIdxRows = await sql`
    SELECT 1 AS present
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'finding_validation_evidence_bundle_status_idx'
  `;
  const uniqueRows = await sql`
    SELECT 1 AS present
    FROM pg_constraint
    WHERE conname = 'finding_validation_evidence_bundle_uniq'
  `;
  return {
    tablePresent: tableRows.length > 0,
    columns: columnRows.map((r) => String(r["column_name"])),
    findingIdx: findingIdxRows.length > 0,
    statusIdx: statusIdxRows.length > 0,
    uniqueConstraint: uniqueRows.length > 0,
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
  console.log("Applying migration 0042_finding_validation_evidence_bundles...");
  await applyMigration0042(sql);
  const verification = await verifyMigration0042(sql);

  console.log("Table present:", verification.tablePresent);
  console.log("Columns:", verification.columns.join(", "));
  console.log("finding_idx present:", verification.findingIdx);
  console.log("status_idx present:", verification.statusIdx);
  console.log("unique constraint present:", verification.uniqueConstraint);

  const expectedColumns = [
    "affected_sha",
    "bundle_status",
    "call_path_trace",
    "created_at",
    "finding_id",
    "id",
    "poc_snippet",
    "reproduction_command",
    "review_attempt",
    "review_id",
    "updated_at",
  ];
  const missing = expectedColumns.filter((col) => !verification.columns.includes(col));
  if (
    !verification.tablePresent ||
    missing.length > 0 ||
    !verification.findingIdx ||
    !verification.statusIdx ||
    !verification.uniqueConstraint
  ) {
    throw new Error(`Migration 0042 verification failed; missing=${missing.join(",") || "none"}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
