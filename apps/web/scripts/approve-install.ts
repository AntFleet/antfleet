/**
 * Admin tool — approve one GitHub App installation/repo pair for AntFleet.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/approve-install.ts <installationId> <repo> [--notes "..."] [--no-patch-agent]
 *
 * Manual partner onboarding should leave Patch Agent enabled by default so
 * benchmark reviews get suggested-patch decisions independent of local env.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

async function main() {
  const [installationIdArg, repo] = process.argv.slice(2);
  if (installationIdArg === undefined || repo === undefined) {
    console.error(
      'usage: pnpm exec tsx scripts/approve-install.ts <installationId> <repo> [--notes "..."]',
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
  const patchAgentEnabled = !process.argv.includes("--no-patch-agent");
  const { listInstallRows, setInstallPatchAgentEnabled, setInstallStatus } = await import(
    "../db/queries"
  );

  const pre = (await listInstallRows()).find(
    (r) => r.installationId === installationId && r.repo === repo,
  );
  console.log("\n[pre-state]");
  console.table(pre === undefined ? [] : [pre]);

  if (pre === undefined) {
    console.error("\n[abort] installation row not found");
    process.exit(1);
  }

  const updated = await setInstallStatus(installationId, repo, "approved", notes);
  if (!updated) {
    console.error("\n[abort] installation row not found");
    process.exit(1);
  }
  if (patchAgentEnabled) {
    const patchUpdated = await setInstallPatchAgentEnabled(installationId, repo, true);
    if (!patchUpdated) {
      console.error("\n[abort] patch-agent opt-in failed; installation row not found");
      process.exit(1);
    }
    console.log("\n[patch-agent] enabled for this install");
  } else {
    console.log("\n[patch-agent] skipped by --no-patch-agent");
  }

  const post = (await listInstallRows()).find(
    (r) => r.installationId === installationId && r.repo === repo,
  );
  console.log("\n[post-state]");
  console.table(post === undefined ? [] : [post]);

  if (
    process.env["ONBOARDER_ENABLED"] === "true" &&
    post?.status === "approved" &&
    pre.owner !== null
  ) {
    const { runWelcomeOnInstall } = await import("../lib/onboarder");
    await runWelcomeOnInstall({ installationId, owner: pre.owner, repo });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
