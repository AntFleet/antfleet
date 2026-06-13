#!/usr/bin/env tsx
// Apply migration 0034 (finding_status label column) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0034.ts [--apply]
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

const sqlFile = readFileSync(join(selfDir, "0034_finding_status_label.sql"), "utf-8");

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (statement: string): Promise<SqlRow[]>;
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
};

export function migration0034Statements(sqlText = sqlFile): string[] {
  return sqlText
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function applyMigration0034(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0034Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 80)}...`);
    await sql(stmt);
  }
}

export async function verifyMigration0034(sql: MigrationSql): Promise<{ columns: string[] }> {
  const columns = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'finding_status'
      AND column_name = 'label'
    ORDER BY column_name
  `;
  return { columns: columns.map((r) => String(r["column_name"])) };
}

async function main() {
  const { url, apply } = await assertSafeToApply();
  if (!apply) {
    console.log("\n--- DRY RUN (pass --apply to execute) ---\n");
    console.log(sqlFile);
    return;
  }

  const sql = neon(url) as MigrationSql;
  console.log("Applying migration 0034_finding_status_label...");
  await applyMigration0034(sql);
  const verification = await verifyMigration0034(sql);

  console.log("Columns present:", verification.columns.join(", "));
  if (!verification.columns.includes("label")) {
    throw new Error("Migration 0034 post-apply verification failed — label column not found");
  }
  console.log("Migration 0034 applied successfully.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
