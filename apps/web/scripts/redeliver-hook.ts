/**
 * Admin tool — redeliver the most recent failed (non-200) webhook deliveries.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/redeliver-hook.ts [--limit N]
 *
 * Fetches the last 20 deliveries, picks the ones with status != 200,
 * and redelivers each via POST /app/hook/deliveries/{id}/attempts.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

async function main() {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : 5;

  const { createAppAuth } = await import("@octokit/auth-app");
  const { Octokit } = await import("@octokit/rest");
  const auth = createAppAuth({
    appId: process.env.GITHUB_APP_ID!,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY!,
  });
  const { token } = await auth({ type: "app" });
  const octokit = new Octokit({ auth: token });

  const deliveries = await octokit.request("GET /app/hook/deliveries", { per_page: 20 });
  const failed = deliveries.data.filter((d) => d.status_code !== 200).slice(0, limit);

  if (failed.length === 0) {
    console.log("[ok] no failed deliveries in last 20 — nothing to redeliver");
    return;
  }

  console.log(`\n[redelivering ${failed.length} failed delivery(s)]`);
  for (const d of failed) {
    console.log(
      `  id=${d.id}  guid=${d.guid}  event=${d.event}.${d.action ?? "?"}  code=${d.status_code}`,
    );
    try {
      await octokit.request("POST /app/hook/deliveries/{delivery_id}/attempts", {
        delivery_id: d.id,
      });
      console.log(`    → redelivered`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    → FAILED: ${msg}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
