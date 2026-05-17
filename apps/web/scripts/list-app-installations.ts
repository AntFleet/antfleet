/**
 * Admin tool — list every account where the AntFleet GitHub App is
 * currently installed. Useful for confirming that an org-transfer or new
 * install was actually picked up by GitHub, since gh CLI cannot query
 * App-installation endpoints (those require a JWT signed by the App's
 * private key, not an OAuth user token).
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/list-app-installations.ts
 *
 * Reads GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY from apps/web/.env.local.
 * Never prints secrets — only mints the App-level JWT, swaps it for the
 * /app/installations listing, and reports.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

async function main() {
  const appId = process.env["GITHUB_APP_ID"];
  const privateKey = process.env["GITHUB_APP_PRIVATE_KEY"];
  if (
    appId === undefined ||
    appId.length === 0 ||
    privateKey === undefined ||
    privateKey.length === 0
  ) {
    console.error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be present in .env.local");
    process.exit(2);
  }

  const { createAppAuth } = await import("@octokit/auth-app");
  const { Octokit } = await import("@octokit/rest");

  const auth = createAppAuth({ appId, privateKey });
  const { token } = await auth({ type: "app" });
  const octokit = new Octokit({ auth: token });

  const { data: installations } = await octokit.rest.apps.listInstallations();

  console.log(`\n[total] ${installations.length} installation(s)\n`);
  if (installations.length === 0) {
    console.log("(no installations — the App exists but no account has it installed)");
    return;
  }

  console.table(
    installations.map((i) => ({
      id: i.id,
      account: i.account && "login" in i.account ? i.account.login : "?",
      type: i.target_type,
      selection: i.repository_selection,
      events: i.events.length,
      createdAt: i.created_at,
    })),
  );

  // Per-installation: list the repos it's scoped to. Each lookup needs an
  // installation-scoped token, so we do this serially per installation.
  for (const inst of installations) {
    const account = inst.account && "login" in inst.account ? inst.account.login : "?";
    const instToken = await auth({ type: "installation", installationId: inst.id });
    const octoInst = new Octokit({ auth: instToken.token });
    const { data } = await octoInst.rest.apps.listReposAccessibleToInstallation();
    console.log(`\n[${account}] installation_id=${inst.id} · ${data.total_count} repo(s):`);
    for (const repo of data.repositories) {
      console.log(`  - ${repo.full_name}${repo.private ? " (private)" : ""}`);
    }
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
