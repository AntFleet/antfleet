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
import { pathToFileURL } from "node:url";
loadDotenv({ path: ".env.local", quiet: true });

const DEFAULT_BASE = "https://www.antfleet.dev";
const TRUSTED_SWEEP_HOSTS = new Set(["www.antfleet.dev", "antfleet-web.vercel.app"]);

export function resolveSweepUrl(
  baseUrl: string = DEFAULT_BASE,
  trustedHosts: ReadonlySet<string> = TRUSTED_SWEEP_HOSTS,
): string {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:") {
    throw new Error("sweep trigger base URL must use https");
  }
  if (!trustedHosts.has(parsed.hostname)) {
    throw new Error(`refusing to send CRON_SECRET to untrusted host: ${parsed.hostname}`);
  }
  return new URL("/api/cron/sweep", parsed.origin).toString();
}

async function main() {
  const baseUrl = process.argv[2] ?? DEFAULT_BASE;
  const secret = process.env["CRON_SECRET"];
  if (secret === undefined || secret.length === 0) {
    console.error("CRON_SECRET not present in .env.local");
    process.exit(2);
  }

  const url = resolveSweepUrl(baseUrl);
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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
