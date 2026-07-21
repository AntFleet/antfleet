#!/usr/bin/env tsx
// Apply migration 0054 (post_drafts operator queue table) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0054.ts [--apply]
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

const sqlFile = readFileSync(join(selfDir, "0054_post_drafts.sql"), "utf-8");

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
  query: (statement: string, params?: unknown[]) => Promise<SqlRow[]>;
};

export function migration0054Statements(sqlText = sqlFile): string[] {
  return splitSqlStatements(sqlText);
}

export async function applyMigration0054(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0054Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql.query(stmt);
  }
}

export async function verifyMigration0054(sql: MigrationSql): Promise<{
  postDraftsTable: boolean;
  pendingSlugUniqueIndex: boolean;
}> {
  const tableRows = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'post_drafts'
  `;
  const indexRows = await sql`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'post_drafts'
      AND indexname = 'post_drafts_pending_slug_uniq'
  `;
  return {
    postDraftsTable: tableRows.length > 0,
    pendingSlugUniqueIndex: indexRows.length > 0,
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
  console.log("Applying migration 0054_post_drafts...");
  await applyMigration0054(sql);
  const verification = await verifyMigration0054(sql);
  console.log("post_drafts table present:", verification.postDraftsTable);
  console.log("post_drafts_pending_slug_uniq index present:", verification.pendingSlugUniqueIndex);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
