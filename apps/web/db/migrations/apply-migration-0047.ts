#!/usr/bin/env tsx
// Apply migration 0047 (SARIF ingest token JTI on import batches + GC docstring) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0047.ts [--apply]
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

const sqlFile = readFileSync(join(selfDir, "0047_sarif_ingest_token_use_gc.sql"), "utf-8");

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
  query: (statement: string, params?: unknown[]) => Promise<SqlRow[]>;
};

export function migration0047Statements(sqlText = sqlFile): string[] {
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

export async function applyMigration0047(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0047Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql.query(stmt);
  }
}

export async function verifyMigration0047(sql: MigrationSql): Promise<{
  ingestTokenJtiColumn: boolean;
  ingestTokenJtiIdx: boolean;
}> {
  const colRows = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sarif_import_batch'
      AND column_name = 'ingest_token_jti'
  `;
  const idxRows = await sql`
    SELECT 1 AS present FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'sarif_import_batch_ingest_token_jti_idx'
  `;
  return {
    ingestTokenJtiColumn: colRows.length > 0,
    ingestTokenJtiIdx: idxRows.length > 0,
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
  console.log("Applying migration 0047_sarif_ingest_token_use_gc...");
  await applyMigration0047(sql);
  const verification = await verifyMigration0047(sql);
  console.log(
    "sarif_import_batch.ingest_token_jti column present:",
    verification.ingestTokenJtiColumn,
  );
  console.log("sarif_import_batch_ingest_token_jti_idx present:", verification.ingestTokenJtiIdx);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
