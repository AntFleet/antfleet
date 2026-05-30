#!/usr/bin/env tsx
// Apply migration 0030 (finding retraction columns) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0030.ts [--apply]
// Without --apply, prints the SQL and exits (dry run).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import * as dotenv from "dotenv";

const selfPath = fileURLToPath(import.meta.url);
const selfDir = dirname(selfPath);

dotenv.config({ path: join(selfDir, "../../.env.local") });

const sqlFile = readFileSync(join(selfDir, "0030_finding_retraction.sql"), "utf-8");

const PROD_PATTERNS = ["neon-fulvous-zebra", "solitary-dew-96858656"];

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (statement: string): Promise<SqlRow[]>;
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
};

export function migration0030Statements(sqlText = sqlFile): string[] {
  return sqlText
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function applyMigration0030(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0030Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql(stmt);
  }
}

export async function verifyMigration0030(sql: MigrationSql): Promise<{ columns: string[] }> {
  const columns = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'finding_status'
      AND column_name IN ('retracted_at', 'retraction_reason', 'retraction_email')
    ORDER BY column_name
  `;
  return { columns: columns.map((r) => String(r["column_name"])) };
}

async function main() {
  const dryRun = !process.argv.includes("--apply");
  if (dryRun) {
    console.log("\n--- DRY RUN (pass --apply to execute) ---\n");
    console.log(sqlFile);
    return;
  }

  const url = process.env["DATABASE_URL"];
  if (!url) {
    console.error("DATABASE_URL not set");
    process.exitCode = 1;
    return;
  }

  const host = url.replace(/^postgresql:\/\/[^@]+@([^/?]+).*/, "$1");
  console.log("Target host:", host);
  if (PROD_PATTERNS.some((p) => host.includes(p))) {
    console.error("REFUSING to run against prod-looking host:", host);
    process.exitCode = 1;
    return;
  }

  const sql = neon(url) as MigrationSql;
  console.log("Applying migration 0030_finding_retraction...");
  await applyMigration0030(sql);
  const verification = await verifyMigration0030(sql);

  console.log("Columns present:", verification.columns.join(", "));
  if (verification.columns.length !== 3) {
    throw new Error("Migration 0030 post-apply verification failed");
  }
  console.log("Migration 0030 applied successfully.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
