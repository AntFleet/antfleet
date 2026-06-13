/**
 * One-off — apply migration 0015 (unique indexes on agent_claims for
 * race-safe verified-claim uniqueness + signature replay prevention).
 * Mirrors apply-migration-0013.ts.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/apply-migration-0015.ts            # dry-run
 *   pnpm exec tsx scripts/apply-migration-0015.ts --apply    # mutate
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertSafeToApply } from "../db/migrations/safety";

const TAG = "0015_agent_claims_unique_indexes";
const JOURNAL_PATH = resolve("db/migrations/meta/_journal.json");
const SQL_PATH = resolve("db/migrations", `${TAG}.sql`);

type JournalEntry = { idx: number; tag: string; when: number };

async function main() {
  const apply = process.argv.includes("--apply");
  if (apply) await assertSafeToApply();
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
    entries: JournalEntry[];
  };
  const entry = journal.entries.find((e) => e.tag === TAG);
  if (entry === undefined) throw new Error(`migration ${TAG} not found in journal`);

  const sqlContent = readFileSync(SQL_PATH, "utf-8");
  const hash = createHash("sha256").update(sqlContent).digest("hex");
  const { Pool } = await import("@neondatabase/serverless");
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is not set — populate apps/web/.env.local");
  }
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const existence =
      (
        await pool.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = 'agent_claims_token_verified_unique'
        ) AS exists
      `)
      ).rows[0]?.exists ?? false;
    console.log(`[agent_claims_token_verified_unique] exists=${existence}`);

    if (!apply) {
      console.log("\ndry-run — pass --apply to mutate.");
      return;
    }

    await pool.query("CREATE SCHEMA IF NOT EXISTS drizzle");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);
    for (const stmt of sqlContent
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)) {
      await pool.query(stmt);
    }
    const tracked =
      (
        await pool.query<{ exists: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = $1) AS exists",
          [hash],
        )
      ).rows[0]?.exists ?? false;
    if (!tracked) {
      await pool.query(
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
        [hash, entry.when],
      );
    }
    console.log("done.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
