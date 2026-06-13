#!/usr/bin/env tsx
// Apply migration 0037 (public-page indexes) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0037.ts [--apply]
// Without --apply, prints the SQL and exits (dry run).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import * as dotenv from "dotenv";
import { assertSafeToApply, databaseHostForLog } from "./safety";

// Re-export to match the pattern the 0035/0036 scripts established for
// test consumers that import the host helper from the apply-migration
// module rather than the shared safety helper.
export { databaseHostForLog };

const selfPath = fileURLToPath(import.meta.url);
const selfDir = dirname(selfPath);

dotenv.config({ path: join(selfDir, "../../.env.local") });

const sqlFile = readFileSync(join(selfDir, "0037_public_page_indexes.sql"), "utf-8");

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
  query: (statement: string, params?: unknown[]) => Promise<SqlRow[]>;
};

export function migration0037Statements(sqlText = sqlFile): string[] {
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

export async function applyMigration0037(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0037Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql.query(stmt);
  }
}

export async function verifyMigration0037(sql: MigrationSql): Promise<{ indexes: string[] }> {
  const indexes = await sql`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN (
        'finding_status_review_id_idx',
        'finding_status_status_closure_idx',
        'reviews_public_receipt_idx'
      )
    ORDER BY indexname
  `;
  return { indexes: indexes.map((r) => String(r["indexname"])) };
}

async function main() {
  const { url, apply } = await assertSafeToApply();
  if (!apply) {
    console.log("\n--- DRY RUN (pass --apply to execute) ---\n");
    console.log(sqlFile);
    return;
  }

  const sql = neon(url) as MigrationSql;
  console.log("Applying migration 0037_public_page_indexes...");
  await applyMigration0037(sql);
  const verification = await verifyMigration0037(sql);

  console.log("Indexes present:", verification.indexes.join(", "));
  if (verification.indexes.length !== 3) {
    throw new Error("Migration 0037 post-apply verification failed");
  }
  console.log("Migration 0037 applied successfully.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
