/**
 * One-off — apply migration 0009 (agent_findings table) to prod
 * directly, bypassing drizzle-kit's migration runner.
 *
 * Why: `pnpm db:migrate` tries to apply every unapplied migration in
 * sequence; an older migration (0007/0008) currently fails on a
 * duplicate-key conflict against prod data and blocks 0009 from
 * running. This script lets us land 0009 (an additive CREATE TABLE
 * with no schema dependencies on the blocked migrations) without
 * resolving the older issue first.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/apply-migration-0009.ts            # dry-run
 *   pnpm exec tsx scripts/apply-migration-0009.ts --apply    # mutate
 *
 * Idempotent: if agent_findings already exists or the tracker row is
 * already present, the script reports and exits cleanly.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const TAG = "0009_bright_radioactive_man";
const JOURNAL_PATH = resolve("db/migrations/meta/_journal.json");
const SQL_PATH = resolve("db/migrations", `${TAG}.sql`);

type JournalEntry = { idx: number; tag: string; when: number };

async function main() {
  const apply = process.argv.includes("--apply");

  const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
    entries: JournalEntry[];
  };
  const entry = journal.entries.find((e) => e.tag === TAG);
  if (entry === undefined) {
    throw new Error(`migration ${TAG} not found in journal`);
  }

  const sqlContent = readFileSync(SQL_PATH, "utf-8");
  const hash = createHash("sha256").update(sqlContent).digest("hex");

  const { Pool } = await import("@neondatabase/serverless");
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is not set — populate apps/web/.env.local");
  }
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // Drizzle creates these lazily; if 0005 ran successfully these already exist.
    if (apply) {
      await pool.query("CREATE SCHEMA IF NOT EXISTS drizzle");
      await pool.query(`
        CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `);
    }

    const tableExistsRow = (
      await pool.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'agent_findings'
        ) AS exists
      `)
    ).rows[0];
    const tableExists = tableExistsRow?.exists ?? false;
    console.log(`[public.agent_findings] exists=${tableExists}`);

    const tracked = apply
      ? ((
          await pool.query<{ exists: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = $1) AS exists",
            [hash],
          )
        ).rows[0]?.exists ?? false)
      : false;
    console.log(`[drizzle.__drizzle_migrations] tag=${TAG} tracked=${tracked}`);

    // Decide work.
    let willCreateTable = false;
    let willInsertTracker = false;
    if (!tableExists) willCreateTable = true;
    if (!tracked) willInsertTracker = true;
    console.log(`plan: createTable=${willCreateTable}  insertTracker=${willInsertTracker}`);

    if (apply) {
      if (willCreateTable) {
        const stmts = sqlContent
          .split("--> statement-breakpoint")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        for (const stmt of stmts) {
          await pool.query(stmt);
        }
        console.log(`  CREATE TABLE agent_findings applied (${stmts.length} statement(s))`);
      }
      if (willInsertTracker) {
        await pool.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [hash, entry.when],
        );
        console.log(`  drizzle tracker row inserted (hash=${hash.slice(0, 12)}…)`);
      }
      console.log("\ndone.");
    } else {
      console.log("\ndry-run — pass --apply to mutate prod.");
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
