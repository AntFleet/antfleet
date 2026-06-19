/**
 * Publish Virtuals acp-node-v2 manual audit findings to `agent_findings`.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/publish-virtuals-acp-node-v2-finding.ts
 *   pnpm exec tsx scripts/publish-virtuals-acp-node-v2-finding.ts --dry-run
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.vercel-actual", quiet: true });

import type { NewAgentFinding } from "../db/schema";

export const VIRTUALS_ACP_NODE_FINDING_ID =
  "virtuals-acp-node-v2-bench-2026-06-19";
export const VIRTUALS_ACP_NODE_AGENT_TOKEN =
  "0x7c8ec0a61287fd68331addcfb8c6f0339a1fc060";

const SUMMARY_MD = `## What was found

AntFleet's Virtuals public repo scan reviewed
[\`Virtual-Protocol/acp-node-v2\`](https://github.com/Virtual-Protocol/acp-node-v2)
on June 10, 2026 using the Opus-first, blind GPT confirmation workflow.

**4 confirmed findings** were filed publicly from \`antfleet-ops\`:

- Solana bigint JSON serialization risk in the older client path. Current
  upstream main no longer contains the referenced
  \`src/clients/solanaAcpClient.ts\` / \`makeIx()\` path, so no stale PR was
  opened for that issue.
- Placeholder \`npm test\` failed intentionally instead of running package
  validation.
- \`AcpJobApi.getActiveJobs()\` was typed as a narrow job-id tuple array while
  \`AcpApiClient\` returns full \`OffChainJob\` records.
- LLM examples imported \`@anthropic-ai/sdk\` without declaring it in package
  dependencies.

Fix PRs were submitted upstream from \`antfleet-ops\` for the findings that
still applied to current upstream main.
`;

const EVIDENCE_MD = `- Methodology anchor: [AntFleet/bench-virtuals-acp-node-v2](https://github.com/AntFleet/bench-virtuals-acp-node-v2)
- Source repo: [Virtual-Protocol/acp-node-v2](https://github.com/Virtual-Protocol/acp-node-v2)
- [Issue #17](https://github.com/Virtual-Protocol/acp-node-v2/issues/17) -> no PR opened; referenced Solana client path is absent on current upstream main
- [Issue #18](https://github.com/Virtual-Protocol/acp-node-v2/issues/18) -> [fix PR #25](https://github.com/Virtual-Protocol/acp-node-v2/pull/25)
- [Issue #19](https://github.com/Virtual-Protocol/acp-node-v2/issues/19) -> [fix PR #24](https://github.com/Virtual-Protocol/acp-node-v2/pull/24)
- [Issue #20](https://github.com/Virtual-Protocol/acp-node-v2/issues/20) -> [fix PR #26](https://github.com/Virtual-Protocol/acp-node-v2/pull/26)
`;

const finding: NewAgentFinding = {
  findingId: VIRTUALS_ACP_NODE_FINDING_ID,
  agentTokenAddress: VIRTUALS_ACP_NODE_AGENT_TOKEN,
  agentName: "Virtuals ACP Node v2",
  repoFullName: "Virtual-Protocol/acp-node-v2",
  benchRepoName: "bench-virtuals-acp-node-v2",
  title:
    "4 findings: stale Solana bigint path, placeholder tests, active-job type mismatch, missing LLM dependency",
  severity: "med",
  summary: SUMMARY_MD,
  evidence: EVIDENCE_MD,
  upstreamPrUrl: "https://github.com/Virtual-Protocol/acp-node-v2/pull/24",
  upstreamMergedSha: null,
};

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  if (!process.env.DATABASE_URL?.includes("ep-crimson-hall") && !dryRun) {
    throw new Error("refusing: DATABASE_URL must point to prod (ep-crimson-hall)");
  }

  console.log("\n[finding payload]");
  console.log(`  finding_id   : ${finding.findingId}`);
  console.log(`  agent_token  : ${finding.agentTokenAddress}`);
  console.log(`  repo         : ${finding.repoFullName}`);
  console.log(`  bench        : ${finding.benchRepoName}`);
  console.log(`  severity     : ${finding.severity}`);
  console.log(`  title        : ${finding.title}`);

  if (dryRun) {
    console.log("\n[dry-run] no DB write");
    return;
  }

  const { upsertAgentFinding } = await import("../db/queries");
  await upsertAgentFinding(finding);
  console.log(`\n[done] upserted - view at https://antfleet.dev/agents/${finding.agentTokenAddress}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
