/**
 * Manual pre-launch dispatcher runner. Mirrors what /api/cron/run-prelaunch
 * does, but invokable from a terminal for debugging.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/run-prelaunch.ts
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

async function main() {
  const { runPrelaunchOnce } = await import("../lib/prelaunch-dispatcher");
  const result = await runPrelaunchOnce();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
