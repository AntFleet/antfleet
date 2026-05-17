/**
 * One-off — apply migration 0005 (onboarding_events table) to prod
 * directly, bypassing drizzle-kit's migration runner.
 *
 * Why: prod was originally seeded via `db:push` (not `db:migrate`), so
 * __drizzle_migrations has no record of 0000-0004 being applied.
 * `db:migrate` then tries to apply from scratch and fails on
 * `CREATE TABLE maintainer_reactions` (already exists).
 *
 * This script (a) backfills __drizzle_migrations with the rows drizzle
 * expects for 0000-0004, then (b) lets drizzle apply 0005 cleanly via
 * the same runner. After this runs once, `pnpm db:migrate` should work
 * for future schema changes.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/apply-migration-0005.ts            # dry-run
 *   pnpm exec tsx scripts/apply-migration-0005.ts --apply    # mutate
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const MIGRATIONS = [
  "0000_wet_butterfly",
  "0001_friendly_beast",
  "0002_lush_nighthawk",
  "0003_high_maggott",
  "0004_eager_psynapse",
  "0005_dark_doctor_octopus",
] as const;

const JOURNAL_PATH = resolve("db/migrations/meta/_journal.json");
const MIGRATIONS_DIR = resolve("db/migrations");

type JournalEntry = { idx: number; tag: string; when: number };

async function main() {
  const apply = process.argv.includes("--apply");

  // Drizzle hashes the SQL content (split by --> statement-breakpoint, then
  // concatenated) to identify a migration. We compute the same hash so the
  // backfilled rows look identical to what drizzle would have written.
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
    entries: JournalEntry[];
  };

  const { Pool } = await import("@neondatabase/serverless");
  const pool = new Pool({ connectionString: process.env["DATABASE_URL"]! });

  try {
    // 1. Ensure __drizzle_migrations table exists (drizzle creates it lazily;
    // a fresh-from-push DB won't have it).
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

    // 2. Inspect what's already tracked.
    const existing = apply
      ? (
          await pool.query<{ hash: string; created_at: number }>(
            "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id",
          )
        ).rows
      : [];
    console.log(`\n[drizzle.__drizzle_migrations] ${existing.length} rows present`);

    // 3. For each migration in the journal, compute the hash and skip if
    // already recorded. For 0000-0004 we ONLY backfill the tracker (the
    // tables themselves already exist from db:push). For 0005 we also run
    // the SQL since the table doesn't exist yet.
    const onboardingEventsExists = apply
      ? (
          await pool.query<{ exists: boolean }>(`
            SELECT EXISTS (
              SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'onboarding_events'
            ) AS exists
          `)
        ).rows[0]?.exists ?? false
      : false;
    console.log(`[public.onboarding_events] exists=${onboardingEventsExists}`);

    for (const tag of MIGRATIONS) {
      const entry = journal.entries.find((e) => e.tag === tag);
      if (!entry) {
        console.log(`  ${tag}: SKIP (not in journal)`);
        continue;
      }
      const sqlPath = resolve(MIGRATIONS_DIR, `${tag}.sql`);
      const sqlContent = readFileSync(sqlPath, "utf-8");
      const hash = createHash("sha256").update(sqlContent).digest("hex");
      const alreadyTracked = existing.some((r) => r.hash === hash);

      if (alreadyTracked) {
        console.log(`  ${tag}: already tracked`);
        continue;
      }

      if (tag === "0005_dark_doctor_octopus" && !onboardingEventsExists) {
        console.log(`  ${tag}: will RUN sql + insert tracker row`);
        if (apply) {
          const stmts = sqlContent
            .split("--> statement-breakpoint")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          for (const stmt of stmts) {
            await pool.query(stmt);
          }
          await pool.query(
            "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
            [hash, entry.when],
          );
        }
      } else {
        console.log(`  ${tag}: backfill tracker row only (table already exists)`);
        if (apply) {
          await pool.query(
            "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
            [hash, entry.when],
          );
        }
      }
    }
  } finally {
    await pool.end();
  }

  if (!apply) {
    console.log("\ndry-run — pass --apply to mutate prod.");
  } else {
    console.log("\ndone. Future `pnpm db:migrate` runs should be no-ops until the next schema change.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
