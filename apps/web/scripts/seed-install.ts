/**
 * Admin tool — manually seed an `installations` row with `approved` status,
 * and optionally create a stub agent page on /agents/[address].
 *
 * Use this when the App is confirmed installed on a repo (visible via
 * list-app-installations.ts or GitHub App settings) but no webhook install
 * event was captured — e.g. the repo pre-dates the installations gate, or
 * the event was delivered before the handler was deployed.
 *
 * Usage:
 *   pnpm exec tsx scripts/seed-install.ts <installationId> <owner> <repo> \
 *     [--token <0x...>] [--notes "..."] [--no-patch-agent]
 *
 * Manual partner onboarding enables Patch Agent by default. Pass
 * --no-patch-agent only when intentionally collecting findings without
 * suggested patches.
 *
 * --token <address>
 *   ERC-20 token address of the agent on Base. When provided, upserts a
 *   minimal stub row in agent_findings so /agents/[address] resolves
 *   immediately. agentName is derived from <repo>. Update the stub later
 *   with a dedicated publish-*.ts script once real findings are in.
 *
 * Idempotent: existing installations row → noop + exit. Existing
 * agent_findings row for the same token → upsert (title/summary preserved).
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

function parseArgs() {
  const [installationIdArg, owner, repo] = process.argv.slice(2);
  if (installationIdArg === undefined || owner === undefined || repo === undefined) {
    console.error(
      'usage: pnpm exec tsx scripts/seed-install.ts <installationId> <owner> <repo> [--token <0x...>] [--notes "..."]',
    );
    process.exit(2);
  }

  const installationId = Number(installationIdArg);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    console.error("installationId must be a positive integer");
    process.exit(2);
  }

  const tokenIdx = process.argv.indexOf("--token");
  const tokenCandidate = tokenIdx !== -1 ? process.argv[tokenIdx + 1] : undefined;
  const tokenAddress =
    tokenCandidate !== undefined && tokenCandidate.startsWith("0x") ? tokenCandidate : undefined;
  if (tokenIdx !== -1 && tokenAddress === undefined) {
    console.error("--token value must be a 0x address");
    process.exit(2);
  }

  const notesIdx = process.argv.indexOf("--notes");
  const notesCandidate = notesIdx !== -1 ? process.argv[notesIdx + 1] : undefined;
  const notes =
    notesCandidate !== undefined && !notesCandidate.startsWith("--") ? notesCandidate : undefined;

  const patchAgentEnabled = !process.argv.includes("--no-patch-agent");

  return { installationId, owner, repo, tokenAddress, notes, patchAgentEnabled };
}

async function main() {
  const { installationId, owner, repo, tokenAddress, notes, patchAgentEnabled } = parseArgs();
  const { listInstallRows, setInstallPatchAgentEnabled, upsertInstallEntry, setInstallStatus } =
    await import("../db/queries");

  // ── 1. installations row ───────────────────────────────────────────────────

  const existing = (await listInstallRows()).find(
    (r) => r.installationId === installationId && r.repo === repo,
  );
  if (existing !== undefined) {
    console.log("\n[noop] installations row already exists:");
    console.table([existing]);
    if (patchAgentEnabled) {
      const patchUpdated = await setInstallPatchAgentEnabled(installationId, repo, true);
      if (!patchUpdated) {
        console.error("[abort] patch-agent opt-in failed; installation row not found");
        process.exit(1);
      }
      const post = (await listInstallRows()).find(
        (r) => r.installationId === installationId && r.repo === repo,
      );
      console.log("\n[patch-agent] enabled for existing install");
      console.table(post === undefined ? [] : [post]);
    } else {
      console.log("\n[patch-agent] skipped by --no-patch-agent");
    }
    process.exit(0);
  }

  const status = await upsertInstallEntry(installationId, owner, repo);
  console.log(`\n[installed] upsertInstallEntry → ${status}`);

  const approved = await setInstallStatus(installationId, repo, "approved", notes);
  if (!approved) {
    console.error("[abort] setInstallStatus returned false");
    process.exit(1);
  }
  if (patchAgentEnabled) {
    const patchUpdated = await setInstallPatchAgentEnabled(installationId, repo, true);
    if (!patchUpdated) {
      console.error("[abort] patch-agent opt-in failed; installation row not found");
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

  // ── 2. agent_findings stub (only when --token is supplied) ────────────────

  if (tokenAddress !== undefined) {
    const { upsertAgentFinding } = await import("../db/queries");
    const agentName = repo.replace(/^agent-/, "").replace(/-bench$/, "");
    const findingId = `seed-${owner.toLowerCase()}-${repo.toLowerCase()}-${new Date().toISOString().slice(0, 10)}`;
    await upsertAgentFinding({
      findingId,
      agentTokenAddress: tokenAddress,
      agentName,
      repoFullName: `${owner}/${repo}`,
      benchRepoName: repo,
      title: "AntFleet benchmark subject — findings pending",
      severity: "info",
      summary: `AntFleet has installed its review App on \`${owner}/${repo}\` and will publish findings as PRs are reviewed. Update this stub with a dedicated \`publish-*.ts\` script once real findings are available.`,
      evidence: null,
      upstreamPrUrl: null,
      upstreamMergedSha: null,
    });
    console.log(`\n[agent] stub upserted → /agents/${tokenAddress}`);
    console.log(`        agentName: ${agentName}`);
    console.log(`        findingId: ${findingId}`);
    console.log("        (update with a publish-*.ts script once real findings exist)");
  } else {
    console.log("\n[agent] skipped — pass --token <0x...> to create /agents page");
  }

  // ── 3. onboarder welcome ───────────────────────────────────────────────────

  if (process.env["ONBOARDER_ENABLED"] === "true" && post?.status === "approved") {
    const { runWelcomeOnInstall } = await import("../lib/onboarder");
    await runWelcomeOnInstall({ installationId, owner, repo });
    console.log("\n[onboarder] welcome fired");
  } else {
    console.log("\n[onboarder] skipped (set ONBOARDER_ENABLED=true to fire)");
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
