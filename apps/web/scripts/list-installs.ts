/**
 * Admin tool — list installation approval rows and compare them with the
 * GitHub App's currently accessible repositories.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/list-installs.ts [--pending|--approved|--rejected]
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

type InstallFilter = "pending_approval" | "approved" | "rejected";

function parseFilter(): InstallFilter | undefined {
  if (process.argv.includes("--pending")) return "pending_approval";
  if (process.argv.includes("--approved")) return "approved";
  if (process.argv.includes("--rejected")) return "rejected";
  return undefined;
}

async function main() {
  const filter = parseFilter();
  const { listInstallRows } = await import("../db/queries");
  const rows = await listInstallRows(filter);

  console.log(`\n[installations db rows] ${rows.length} row(s)\n`);
  console.table(
    rows.map((r) => ({
      installationId: r.installationId,
      owner: r.owner,
      repo: r.repo,
      status: r.status,
      notes: r.notes,
      createdAt: r.createdAt.toISOString(),
      approvedAt: r.approvedAt?.toISOString() ?? null,
    })),
  );

  const appId = process.env["GITHUB_APP_ID"];
  const privateKey = process.env["GITHUB_APP_PRIVATE_KEY"];
  if (
    appId === undefined ||
    appId.length === 0 ||
    privateKey === undefined ||
    privateKey.length === 0
  ) {
    console.log("\n[github] skipped — GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required");
    return;
  }

  const { createAppAuth } = await import("@octokit/auth-app");
  const { Octokit } = await import("@octokit/rest");

  const auth = createAppAuth({ appId, privateKey });
  const { token } = await auth({ type: "app" });
  const octokit = new Octokit({ auth: token });
  const { data: installations } = await octokit.rest.apps.listInstallations();

  const dbPairs = new Set(rows.map((r) => `${r.installationId}:${r.repo}`));
  const missingRows: Array<{ installationId: number; owner: string; repo: string }> = [];

  for (const inst of installations) {
    const account = inst.account && "login" in inst.account ? inst.account.login : "?";
    const instToken = await auth({ type: "installation", installationId: inst.id });
    const octoInst = new Octokit({ auth: instToken.token });
    const { data } = await octoInst.rest.apps.listReposAccessibleToInstallation();
    for (const repo of data.repositories) {
      if (!dbPairs.has(`${inst.id}:${repo.name}`)) {
        missingRows.push({ installationId: inst.id, owner: account, repo: repo.name });
      }
    }
  }

  console.log(`\n[github cross-check] ${missingRows.length} accessible repo(s) missing DB row\n`);
  if (missingRows.length > 0) {
    console.table(missingRows);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
