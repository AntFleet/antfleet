/**
 * Admin tool — fire the production cron sweep on demand instead of waiting
 * for the daily 06:00 UTC firing. Used when verifying receipts pipeline
 * end-to-end after a known closure (PR merged, file changed on main).
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/trigger-sweep.ts [<base-url>]
 *
 * Default base URL is https://antfleet-web.vercel.app. Reads CRON_SECRET
 * from apps/web/.env.local and sends it as `Authorization: Bearer ...`.
 * Never prints the secret. Prints HTTP status + JSON response body.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

const DEFAULT_BASE = "https://antfleet-web.vercel.app";

async function main() {
  const baseUrl = process.argv[2] ?? DEFAULT_BASE;
  const secret = process.env["CRON_SECRET"];
  if (secret === undefined || secret.length === 0) {
    console.error("CRON_SECRET not present in .env.local");
    process.exit(2);
  }

  const url = `${baseUrl}/api/cron/sweep`;
  console.log(`[trigger] ${url}`);

  const t0 = Date.now();
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${secret}` },
  });
  const elapsedMs = Date.now() - t0;
  const text = await resp.text();
  console.log(`[response] status=${resp.status} elapsed=${elapsedMs}ms`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
  if (!resp.ok) process.exit(1);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
