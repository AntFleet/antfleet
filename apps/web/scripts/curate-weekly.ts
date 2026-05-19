/**
 * Auto-curate the receipt of the week.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/curate-weekly.ts            # dry-run
 *   pnpm exec tsx scripts/curate-weekly.ts --apply    # mutate
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

import { logError, messageOf } from "../lib/log";
import { curateWeekly } from "../lib/curate-weekly";

async function main() {
  const apply = process.argv.includes("--apply");
  const { Pool } = await import("@neondatabase/serverless");
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is not set — populate apps/web/.env.local");
  }
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const result = await curateWeekly({ pool, apply });
    // eslint-disable-next-line no-console
    console.log(`status: ${result.status}`);
    // eslint-disable-next-line no-console
    console.log(`week_start: ${result.weekStart}`);
    if ("pickedFindingId" in result) {
      // eslint-disable-next-line no-console
      console.log(`picked: ${result.pickedFindingId}`);
    }
  } finally {
    await pool.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logError("curate_weekly.failed", { message: messageOf(err) });
    process.exit(1);
  });
