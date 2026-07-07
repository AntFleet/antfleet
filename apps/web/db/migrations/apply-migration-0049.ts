#!/usr/bin/env tsx
// Apply migration 0049 (maintainer_reactions attribution columns) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0049.ts [--apply]
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

const sqlFile = readFileSync(
  join(selfDir, "0049_maintainer_reactions_attribution.sql"),
  "utf-8",
);

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
  query: (statement: string, params?: unknown[]) => Promise<SqlRow[]>;
};

export function migration0049Statements(sqlText = sqlFile): string[] {
  return splitSqlStatements(sqlText);
}

export async function applyMigration0049(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0049Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql.query(stmt);
  }
}

export async function verifyMigration0049(sql: MigrationSql): Promise<{
  reactorLoginColumn: boolean;
  authorAssociationColumn: boolean;
}> {
  const reactorLoginRows = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'maintainer_reactions'
      AND column_name = 'reactor_login'
  `;
  const authorAssociationRows = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'maintainer_reactions'
      AND column_name = 'author_association'
  `;
  return {
    reactorLoginColumn: reactorLoginRows.length > 0,
    authorAssociationColumn: authorAssociationRows.length > 0,
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
  console.log("Applying migration 0049_maintainer_reactions_attribution...");
  await applyMigration0049(sql);
  const verification = await verifyMigration0049(sql);
  console.log(
    "maintainer_reactions.reactor_login column present:",
    verification.reactorLoginColumn,
  );
  console.log(
    "maintainer_reactions.author_association column present:",
    verification.authorAssociationColumn,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
