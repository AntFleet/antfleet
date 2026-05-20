/**
 * Admin tool — reject one GitHub App installation/repo pair for AntFleet.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/reject-install.ts <installationId> <repo> [--notes "..."]
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

async function main() {
  const [installationIdArg, repo] = process.argv.slice(2);
  if (installationIdArg === undefined || repo === undefined) {
    console.error(
      'usage: pnpm exec tsx scripts/reject-install.ts <installationId> <repo> [--notes "..."]',
    );
    process.exit(2);
  }

  const installationId = Number(installationIdArg);
  if (!Number.isInteger(installationId)) {
    console.error("installationId must be an integer");
    process.exit(2);
  }

  const notesIdx = process.argv.indexOf("--notes");
  const notesCandidate = notesIdx !== -1 ? process.argv[notesIdx + 1] : undefined;
  const notes =
    notesCandidate !== undefined && !notesCandidate.startsWith("--") ? notesCandidate : undefined;
  const { listInstallRows, setInstallStatus } = await import("../db/queries");

  const pre = (await listInstallRows()).find(
    (r) => r.installationId === installationId && r.repo === repo,
  );
  console.log("\n[pre-state]");
  console.table(pre === undefined ? [] : [pre]);

  if (pre === undefined) {
    console.error("\n[abort] installation row not found");
    process.exit(1);
  }

  const updated = await setInstallStatus(installationId, repo, "rejected", notes);
  if (!updated) {
    console.error("\n[abort] installation row not found");
    process.exit(1);
  }

  const post = (await listInstallRows()).find(
    (r) => r.installationId === installationId && r.repo === repo,
  );
  console.log("\n[post-state]");
  console.table(post === undefined ? [] : [post]);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
