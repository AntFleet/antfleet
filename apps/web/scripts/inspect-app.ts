/**
 * Admin tool — print top-level metadata about the AntFleet GitHub App:
 * name, slug, subscribed events, required permissions. Used to confirm
 * an App settings change (e.g. flipping visibility from private to
 * public, or adding a new permission scope) actually landed on the
 * live App definition.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/inspect-app.ts
 *
 * Reads GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY from apps/web/.env.local
 * and mints an App-level JWT to call /app. Never prints secrets.
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
  const { data: app } = await octokit.rest.apps.getAuthenticated();
  console.log("name:", app?.name);
  console.log("slug:", app?.slug);
  console.log("html_url:", app?.html_url);
  console.log("external_url (homepage):", app?.external_url);
  console.log("hook events:", app?.events);
  console.log("permissions:", JSON.stringify(app?.permissions, null, 2));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
