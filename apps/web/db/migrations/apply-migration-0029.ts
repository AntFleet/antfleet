#!/usr/bin/env tsx
// Apply migration 0029 (patch-cost token columns) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0029.ts [--apply]
// Without --apply, prints the SQL and exits (dry run).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import * as dotenv from "dotenv";
import { assertSafeToApply } from "./safety";

const selfPath = fileURLToPath(import.meta.url);
const selfDir = dirname(selfPath);

dotenv.config({ path: join(selfDir, "../../.env.local") });

const sqlFile = readFileSync(join(selfDir, "0029_patch_cost_tokens.sql"), "utf-8");

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
  query: (statement: string, params?: unknown[]) => Promise<SqlRow[]>;
};

export function migration0029Statements(sqlText = sqlFile): string[] {
  return sqlText
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function applyMigration0029(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0029Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql.query(stmt);
  }
}

export async function verifyMigration0029(sql: MigrationSql): Promise<{ columns: string[] }> {
  const columns = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'finding_status'
      AND column_name IN (
        'input_tokens_opus',
        'output_tokens_opus',
        'input_tokens_gpt5',
        'output_tokens_gpt5'
      )
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
  console.log("Applying migration 0029_patch_cost_tokens...");
  await applyMigration0029(sql);
  const verification = await verifyMigration0029(sql);

  console.log("Columns present:", verification.columns.join(", "));
  if (verification.columns.length !== 4) {
    throw new Error("Migration 0029 post-apply verification failed");
  }
  console.log("Migration 0029 applied successfully.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
