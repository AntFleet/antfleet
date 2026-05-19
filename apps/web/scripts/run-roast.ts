/**
 * Manual roast runner. Picks the oldest queued roast_submissions row,
 * runs it through the reviewer, and either publishes findings or marks
 * the row rejected. Mirrors what the /api/cron/roast endpoint does, but
 * usable from a terminal.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/run-roast.ts
 *
 * Reads ANTHROPIC_API_KEY, OPENAI_API_KEY (or whatever the providers in
 * review-pipeline.ts need), DATABASE_URL, ROAST_GH_TOKEN (optional —
 * raises GitHub's unauth 60-req/hr limit).
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

async function main() {
  const { runOneRoast } = await import("../lib/roast-runner");
  const result = await runOneRoast();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "rejected") {
    process.exit(2);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
