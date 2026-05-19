/**
 * One-off — TRUNCATE factory_launches and clear the poll-factory.* cron
 * cursors. Used to reset state after the Sprint 3 backfill caught 2k+
 * memecoins from the general Liquid factory before we discovered there's no
 * agents-specific factory contract yet (see runbook §3, Sprint 3 entry).
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/wipe-factory-launches.ts            # dry-run
 *   pnpm exec tsx scripts/wipe-factory-launches.ts --apply    # mutate
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

async function main() {
  const apply = process.argv.includes("--apply");
  const { Pool } = await import("@neondatabase/serverless");
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is not set — populate apps/web/.env.local");
  }
  const host = databaseUrl.match(/@([^/]+)/)?.[1] ?? "(unknown)";
  // eslint-disable-next-line no-console
  console.log(`target host: ${host}`);

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const before = await pool.query<{ rows: number }>(
      "SELECT COUNT(*)::int AS rows FROM factory_launches",
    );
    const cursors = await pool.query<{ key: string; value: string }>(
      "SELECT key, value FROM cron_cursors WHERE key LIKE 'poll-factory.%'",
    );
    // eslint-disable-next-line no-console
    console.log(`factory_launches rows: ${before.rows[0]?.rows ?? 0}`);
    // eslint-disable-next-line no-console
    console.log(
      `poll-factory.* cursors: ${cursors.rows.map((r) => `${r.key}=${r.value}`).join(", ") || "(none)"}`,
    );

    if (!apply) {
      // eslint-disable-next-line no-console
      console.log("\ndry-run — pass --apply to mutate.");
      return;
    }

    await pool.query("TRUNCATE TABLE factory_launches");
    await pool.query("DELETE FROM cron_cursors WHERE key LIKE 'poll-factory.%'");

    const after = await pool.query<{ rows: number }>(
      "SELECT COUNT(*)::int AS rows FROM factory_launches",
    );
    // eslint-disable-next-line no-console
    console.log(`done. factory_launches rows after: ${after.rows[0]?.rows ?? 0}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
