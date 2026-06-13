#!/usr/bin/env tsx
// Apply migration 0035 (Patch Agent patch skip reason per side) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0035.ts [--apply]
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

const sqlFile = readFileSync(join(selfDir, "0035_patch_skip_reason_per_side.sql"), "utf-8");

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (statement: string): Promise<SqlRow[]>;
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
};

export function migration0035Statements(sqlText = sqlFile): string[] {
  const uncommented = sqlText
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  const statements: string[] = [];
  let current = "";
  let inDollarQuote = false;

  for (let i = 0; i < uncommented.length; i += 1) {
    if (uncommented.startsWith("$$", i)) {
      inDollarQuote = !inDollarQuote;
      current += "$$";
      i += 1;
      continue;
    }

    const char = uncommented.charAt(i);
    if (char === ";" && !inDollarQuote) {
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

export async function applyMigration0035(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0035Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql(stmt);
  }
}

export async function verifyMigration0035(sql: MigrationSql): Promise<{ columns: string[] }> {
  const columns = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'finding_status'
      AND column_name IN ('patch_skip_reason_opus', 'patch_skip_reason_gpt5')
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
  console.log("Applying migration 0035_patch_skip_reason_per_side...");
  await applyMigration0035(sql);
  const verification = await verifyMigration0035(sql);

  console.log("Columns present:", verification.columns.join(", "));
  if (verification.columns.length !== 2) {
    throw new Error("Migration 0035 post-apply verification failed");
  }
  console.log("Migration 0035 applied successfully.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
