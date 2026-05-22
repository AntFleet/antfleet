/**
 * One-off — apply migration 0021 (review_challenges table) to prod
 * directly, bypassing drizzle-kit's migration runner.
 *
 * Why: the team convention (see apply-migration-0005.ts and
 * apply-migration-0009.ts) is to apply each new migration with a
 * dedicated script so prod's __drizzle_migrations tracker stays in
 * sync with what's actually applied. 0021 is purely additive — a new
 * CREATE TABLE + two indexes — with no dependency on any prior
 * schema state beyond the existing `installations` and `reviews`
 * tables (both live in prod since the paywall MVP shipped).
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/apply-migration-0021.ts            # dry-run
 *   pnpm exec tsx scripts/apply-migration-0021.ts --apply    # mutate
 *
 * Idempotent: if review_challenges already exists or the tracker row
 * is already present, the script reports the state and exits cleanly
 * without re-applying anything.
 *
 * What this enables: POST /api/v1/installations/{id}/review/challenge
 * and POST /api/v1/installations/{id}/review (the Aeon partnership
 * on-demand review endpoints). Until this script runs against prod,
 * the first real call from a wallet-bound install will 500 on
 * `INSERT INTO review_challenges` (relation does not exist).
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const TAG = "0021_review_challenges";
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
    // Drizzle's migration metadata schema is created lazily; defensive
    // CREATE IF NOT EXISTS so a fresh DB that has never seen drizzle-kit
    // run still ends up with the tracker. On prod these were created when
    // 0005 was applied, so this is a no-op in practice.
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
          WHERE table_schema = 'public' AND table_name = 'review_challenges'
        ) AS exists
      `)
    ).rows[0];
    const tableExists = tableExistsRow?.exists ?? false;
    console.log(`[public.review_challenges] exists=${tableExists}`);

    // Verify the prerequisite tables exist before we try to add FKs
    // against them. installations and reviews have been live since the
    // paywall MVP shipped, so this should always be true on prod; the
    // check prevents a confusing FK error if someone runs this against
    // an empty DB by mistake.
    const prereqRow = (
      await pool.query<{ installations: boolean; reviews: boolean }>(`
        SELECT
          EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='installations') AS installations,
          EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='reviews') AS reviews
      `)
    ).rows[0];
    const installationsExists = prereqRow?.installations ?? false;
    const reviewsExists = prereqRow?.reviews ?? false;
    console.log(
      `[prereqs] public.installations=${installationsExists}  public.reviews=${reviewsExists}`,
    );
    if (!installationsExists || !reviewsExists) {
      throw new Error(
        "prerequisite tables missing — refusing to apply 0021 against an unprepared DB. Run earlier migrations first.",
      );
    }

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
      // All mutations run inside a single transaction so a failure
      // midway (e.g. CREATE INDEX errors after CREATE TABLE succeeds)
      // rolls back to a clean pre-migration state. Without this, a
      // half-applied migration would leave the table without its
      // indexes or the tracker out of sync with the schema — which
      // breaks the next `pnpm db:migrate` invocation with a confusing
      // "relation already exists" error.
      //
      // Postgres allows CREATE TABLE and CREATE INDEX inside an
      // explicit BEGIN ... COMMIT; the only DDL that cannot run in a
      // transaction is CREATE INDEX CONCURRENTLY, which we don't use
      // here (the table starts empty so a brief lock is fine).
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (willCreateTable) {
          // The migration SQL is structured as statement-breakpoint
          // chunks (one CREATE TABLE + two CREATE INDEX). Split and
          // apply each separately so a single statement failure
          // surfaces clearly rather than nesting under one combined
          // error.
          const stmts = sqlContent
            .split("--> statement-breakpoint")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          for (const stmt of stmts) {
            await client.query(stmt);
          }
          console.log(
            `  CREATE TABLE review_challenges + indexes applied (${stmts.length} statement(s))`,
          );
        } else {
          console.log("  skip: review_challenges already exists (idempotent)");
        }
        if (willInsertTracker) {
          await client.query(
            "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
            [hash, entry.when],
          );
          console.log(`  drizzle tracker row inserted (hash=${hash.slice(0, 12)}…)`);
        } else {
          console.log("  skip: drizzle tracker already records this migration");
        }
        await client.query("COMMIT");
        console.log("\ndone (transaction committed).");
      } catch (err) {
        try {
          await client.query("ROLLBACK");
          console.error("rolled back transaction; no schema changes were persisted.");
        } catch (rollbackErr) {
          console.error("ROLLBACK itself failed:", rollbackErr);
        }
        throw err;
      } finally {
        client.release();
      }
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
