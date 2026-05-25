/**
 * Publish Reppo CLI agent findings to `agent_findings`.
 *
 * Reppo is a CLI for Reppo — mint pods, vote, lock REPPO, manage datanets.
 * AntFleet's two-model consensus review (Claude Opus 4.7 + GPT-5) ran 3 PRs
 * on AntFleet/bench-reppo-cli covering the auth/API, register-agent, and
 * pod-listing surfaces. 2 docs-gap findings (medium + low severity).
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/publish-reppo-cli-finding.ts             # insert/update
 *   pnpm exec tsx scripts/publish-reppo-cli-finding.ts --dry-run   # print payload only
 *   pnpm exec tsx scripts/publish-reppo-cli-finding.ts --update --pr-url <url>
 *
 * Idempotent: re-running rewrites mutable columns but preserves publishedAt.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

import type { NewAgentFinding } from "../db/schema";

export const REPPO_CLI_FINDING_ID = "reppo-cli-bench-2026-05-25";
export const REPPO_AGENT_TOKEN = "0x70000c1cb3ee34a7323211607ac3162665b49549";

const SUMMARY_MD = `## What was found

AntFleet's two-model consensus review (Claude Opus 4.7 + GPT-5) ran against
3 PRs on [\`AntFleet/bench-reppo-cli\`](https://github.com/AntFleet/bench-reppo-cli),
covering the register-agent API spec, authentication + emissions-due query surface,
and community pod-listing feature.

**2 unanimous docs-gap findings** across the auth/registration layer:

**1. README auth table incorrectly claims \`REPPO_API_KEY\` required for \`register-agent\`**

The documentation lists \`REPPO_API_KEY\` as a required credential for
\`register-agent\`, but the implementation calls an unauthenticated endpoint
(\`POST /api/v1/agents/register (no auth)\`). The command actually *returns*
the API key — it doesn't consume one. This can mislead operators into blocking
on a credential they don't have and missing that the returned key is what
authorizes subsequent agent-scoped endpoints. *(medium, PR #1)*

**2. Session schema docstring lists \`agentId\` as a session field, but sessions never persist it**

The \`db.ts\` schema comment shows \`agentId\` as a top-level field of the
persisted session entry, but \`signInWithEthereum\` only stores
\`accessToken / walletAddress / expiresAt / createdAt\`. The interface already
marks \`agentId\` optional; the comment just needs aligning. *(low, PR #2)*

A clean pass on the pod-listing surface (PR #3, 0 unanimous findings).
`;

const EVIDENCE_MD = `- Benchmark repo: [AntFleet/bench-reppo-cli](https://github.com/AntFleet/bench-reppo-cli)
- Register-agent spec bench PR: [AntFleet/bench-reppo-cli#1](https://github.com/AntFleet/bench-reppo-cli/pull/1) (1 finding) · [review comment](https://github.com/AntFleet/bench-reppo-cli/pull/1#issuecomment-4532169615)
- Auth + emissions bench PR: [AntFleet/bench-reppo-cli#2](https://github.com/AntFleet/bench-reppo-cli/pull/2) (1 finding) · [review comment](https://github.com/AntFleet/bench-reppo-cli/pull/2#issuecomment-4532184554)
- Pod-listing bench PR: [AntFleet/bench-reppo-cli#3](https://github.com/AntFleet/bench-reppo-cli/pull/3) (0 findings)
- Source repo: [Reppo-Labs/reppo-cli](https://github.com/Reppo-Labs/reppo-cli)
- Token: [0x7000…549 on Base](https://basescan.org/token/0x70000c1cb3ee34a7323211607ac3162665b49549)
`;

const finding: NewAgentFinding = {
  findingId: REPPO_CLI_FINDING_ID,
  agentTokenAddress: REPPO_AGENT_TOKEN,
  agentName: "Reppo",
  repoFullName: "Reppo-Labs/reppo-cli",
  benchRepoName: "bench-reppo-cli",
  title: "README auth table misrepresents register-agent credential requirements (2 docs-gap findings)",
  severity: "medium",
  summary: SUMMARY_MD,
  evidence: EVIDENCE_MD,
  upstreamPrUrl: null,
  upstreamMergedSha: null,
};

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const update = args.includes("--update");
  const prUrlIdx = args.indexOf("--pr-url");
  if (update && prUrlIdx !== -1) {
    finding.upstreamPrUrl = args[prUrlIdx + 1] ?? null;
  }

  console.log("\n[finding payload]");
  console.log(`  finding_id   : ${finding.findingId}`);
  console.log(`  agent_token  : ${finding.agentTokenAddress}`);
  console.log(`  agent_name   : ${finding.agentName}`);
  console.log(`  repo         : ${finding.repoFullName}`);
  console.log(`  severity     : ${finding.severity}`);
  console.log(`  title        : ${finding.title}`);
  if (finding.upstreamPrUrl) console.log(`  upstream_pr  : ${finding.upstreamPrUrl}`);

  if (dryRun) {
    console.log("\n[dry-run] no DB write");
    return;
  }

  const { upsertAgentFinding } = await import("../db/queries");
  await upsertAgentFinding(finding);
  console.log(`\n[done] upserted successfully — view at /agents/${REPPO_AGENT_TOKEN}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
