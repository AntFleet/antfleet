#!/usr/bin/env tsx
// Apply migration 0044 (finding disclosure state machine) to the DB.
// Usage: pnpm exec tsx db/migrations/apply-migration-0044.ts [--apply]
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

const sqlFile = readFileSync(join(selfDir, "0044_finding_disclosure.sql"), "utf-8");

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
  query: (statement: string, params?: unknown[]) => Promise<SqlRow[]>;
};

export function migration0044Statements(sqlText = sqlFile): string[] {
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

export async function applyMigration0044(sql: MigrationSql, sqlText = sqlFile): Promise<void> {
  for (const stmt of migration0044Statements(sqlText)) {
    console.log(`  Running: ${stmt.slice(0, 70)}...`);
    await sql.query(stmt);
  }
}

export async function verifyMigration0044(sql: MigrationSql): Promise<{
  disclosurePresent: boolean;
  logPresent: boolean;
  disclosureColumns: string[];
  logColumns: string[];
  installLiveProtocolColumn: boolean;
  stateIdx: boolean;
  logFindingIdx: boolean;
}> {
  const tableRows = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('finding_disclosure', 'finding_disclosure_log')
  `;
  const disclosureColumnRows = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'finding_disclosure'
    ORDER BY column_name
  `;
  const logColumnRows = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'finding_disclosure_log'
    ORDER BY column_name
  `;
  const installColumnRows = await sql`
    SELECT 1 AS present
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'installations'
      AND column_name = 'is_live_protocol'
  `;
  const stateIdxRows = await sql`
    SELECT 1 AS present
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'finding_disclosure_state_idx'
  `;
  const logFindingIdxRows = await sql`
    SELECT 1 AS present
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'finding_disclosure_log_finding_idx'
  `;
  const tables = new Set(tableRows.map((r) => String(r["table_name"])));
  return {
    disclosurePresent: tables.has("finding_disclosure"),
    logPresent: tables.has("finding_disclosure_log"),
    disclosureColumns: disclosureColumnRows.map((r) => String(r["column_name"])),
    logColumns: logColumnRows.map((r) => String(r["column_name"])),
    installLiveProtocolColumn: installColumnRows.length > 0,
    stateIdx: stateIdxRows.length > 0,
    logFindingIdx: logFindingIdxRows.length > 0,
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
  console.log("Applying migration 0044_finding_disclosure...");
  await applyMigration0044(sql);
  const verification = await verifyMigration0044(sql);

  console.log("finding_disclosure present:", verification.disclosurePresent);
  console.log("finding_disclosure columns:", verification.disclosureColumns.join(", "));
  console.log("finding_disclosure_log present:", verification.logPresent);
  console.log("finding_disclosure_log columns:", verification.logColumns.join(", "));
  console.log("installations.is_live_protocol present:", verification.installLiveProtocolColumn);
  console.log("state_idx present:", verification.stateIdx);
  console.log("log_finding_idx present:", verification.logFindingIdx);

  const expectedDisclosureColumns = [
    "acknowledged_at",
    "acknowledged_by",
    "advisory_draft",
    "advisory_draft_updated_at",
    "created_at",
    "cve_id",
    "cve_requested_at",
    "embargo_expires_at",
    "entered_at",
    "finding_id",
    "forced_by",
    "ghsa_html_url",
    "ghsa_id",
    "ghsa_published_at",
    "ghsa_reservation_token",
    "maintainer_url_ciphertext",
    "maintainer_url_log_id",
    "review_id",
    "state",
    "updated_at",
  ];
  const expectedLogColumns = [
    "actor_id",
    "actor_type",
    "at_sha",
    "created_at",
    "finding_id",
    "from_state",
    "id",
    "metadata",
    "reason",
    "to_state",
  ];
  const missingDisclosure = expectedDisclosureColumns.filter(
    (col) => !verification.disclosureColumns.includes(col),
  );
  const missingLog = expectedLogColumns.filter((col) => !verification.logColumns.includes(col));
  if (
    !verification.disclosurePresent ||
    !verification.logPresent ||
    !verification.installLiveProtocolColumn ||
    !verification.stateIdx ||
    !verification.logFindingIdx ||
    missingDisclosure.length > 0 ||
    missingLog.length > 0
  ) {
    throw new Error(
      `Migration 0044 verification failed; missingDisclosure=${
        missingDisclosure.join(",") || "none"
      } missingLog=${missingLog.join(",") || "none"}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
