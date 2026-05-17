/**
 * Admin tool — print the AntFleet GitHub App's webhook config and the
 * last 8 webhook delivery attempts (with status code, event type,
 * installation id, and GitHub's delivery GUID). Used to diagnose
 * webhook-not-firing situations: if the App says deliveries succeeded
 * (status 200) but our Vercel logs show no POST, the issue is
 * downstream (e.g., wrong host filter on log queries).
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/inspect-app-hook.ts
 *
 * Reads GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY from apps/web/.env.local
 * and mints an App-level JWT. Never prints secrets.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

async function main() {
  const { createAppAuth } = await import("@octokit/auth-app");
  const { Octokit } = await import("@octokit/rest");
  const auth = createAppAuth({
    appId: process.env.GITHUB_APP_ID!,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY!,
  });
  const { token } = await auth({ type: "app" });
  const octokit = new Octokit({ auth: token });
  const hookConfig = await octokit.request("GET /app/hook/config");
  console.log("\n[App webhook config]");
  console.log("url:", hookConfig.data.url);
  console.log("content_type:", hookConfig.data.content_type);
  console.log("insecure_ssl:", hookConfig.data.insecure_ssl);
  const deliveries = await octokit.request("GET /app/hook/deliveries", { per_page: 8 });
  console.log("\n[Last 8 webhook deliveries]");
  for (const d of deliveries.data) {
    console.log(`  ${d.delivered_at}  ${d.status_code ?? "—"}  ${d.event}.${d.action ?? "?"}  installation=${d.installation_id ?? "—"}  repo_id=${d.repository_id ?? "—"}  delivery=${d.guid}  status=${d.status}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
