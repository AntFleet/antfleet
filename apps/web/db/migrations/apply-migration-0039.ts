#!/usr/bin/env tsx
// Apply migration 0039 (x402_review_claims table + indexes) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0039.ts [--apply]
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

const sqlFile = readFileSync(join(selfDir, "0039_x402_review_claims.sql"), "utf-8");

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
  query: (statement: string, params?: unknown[]) => Promise<SqlRow[]>;
};

export function migration0039Statements(sqlText = sqlFile): string[] {
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

export async function applyMigration0039(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0039Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql.query(stmt);
  }
}

export async function verifyMigration0039(sql: MigrationSql): Promise<{
  table: boolean;
  indexes: string[];
  checkConstraint: boolean;
}> {
  const tableRows = await sql`
    SELECT to_regclass('public.x402_review_claims') AS oid
  `;
  const tablePresent = tableRows[0]?.["oid"] !== null && tableRows[0]?.["oid"] !== undefined;

  const indexes = await sql`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'x402_review_claims'
    ORDER BY indexname
  `;

  const checkRows = await sql`
    SELECT conname
    FROM pg_constraint
    WHERE conname = 'x402_review_claims_status_check'
  `;

  return {
    table: tablePresent,
    indexes: indexes.map((r) => String(r["indexname"])),
    checkConstraint: checkRows.length > 0,
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
  console.log("Applying migration 0039_x402_review_claims...");
  await applyMigration0039(sql);
  const verification = await verifyMigration0039(sql);

  console.log("Table present:", verification.table);
  console.log("Indexes present:", verification.indexes.join(", "));
  console.log("Status check constraint present:", verification.checkConstraint);

  const expectedIndexes = [
    "x402_review_claims_authorization_key_uniq",
    "x402_review_claims_pkey",
    "x402_review_claims_repo_created_idx",
    "x402_review_claims_status_idx",
    "x402_review_claims_wallet_created_idx",
  ];
  const missing = expectedIndexes.filter((idx) => !verification.indexes.includes(idx));
  if (!verification.table || !verification.checkConstraint || missing.length > 0) {
    throw new Error(
      `Migration 0039 post-apply verification failed (missing: ${missing.join(", ") || "(check/table)"})`,
    );
  }
  console.log("Migration 0039 applied successfully.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
