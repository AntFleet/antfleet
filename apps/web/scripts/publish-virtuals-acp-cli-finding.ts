/**
 * Publish Virtuals acp-cli manual audit findings to `agent_findings`.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/publish-virtuals-acp-cli-finding.ts
 *   pnpm exec tsx scripts/publish-virtuals-acp-cli-finding.ts --dry-run
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.vercel-actual", quiet: true });

import type { NewAgentFinding } from "../db/schema";

export const VIRTUALS_ACP_CLI_FINDING_ID = "virtuals-acp-cli-bench-2026-06-19";
export const VIRTUALS_ACP_CLI_AGENT_TOKEN =
  "0x24444fa62df978a78e8d35c63fd6a1c123c191a6";

const SUMMARY_MD = `## What was found

AntFleet's Virtuals public repo scan reviewed
[\`Virtual-Protocol/acp-cli\`](https://github.com/Virtual-Protocol/acp-cli)
on June 10, 2026 using the Opus-first, blind GPT confirmation workflow.

**4 confirmed findings** were filed publicly from \`antfleet-ops\`:

- **HIGH / recoverability:** backend confirmation failures after an on-chain
  broadcast hid the transaction hash needed for manual reconciliation.
- **HIGH / data loss:** \`events drain\` could overwrite events appended by a
  concurrent \`events listen --output\` process.
- **MEDIUM / formatter crash:** non-TTY \`job list\` called \`BigInt()\` on a
  missing v2 budget that the TTY path already treated as \`N/A\`.
- **MEDIUM / durability:** local ACP config writes truncated the final file in
  place, so an interrupted write could leave partial JSON and make local agent
  state appear missing.

Fix PRs were submitted upstream from \`antfleet-ops\` after maintainers did not
respond to the issues.
`;

const EVIDENCE_MD = `- Methodology anchor: [AntFleet/bench-virtuals-acp-cli](https://github.com/AntFleet/bench-virtuals-acp-cli)
- Source repo: [Virtual-Protocol/acp-cli](https://github.com/Virtual-Protocol/acp-cli)
- [Issue #37](https://github.com/Virtual-Protocol/acp-cli/issues/37) -> [fix PR #53](https://github.com/Virtual-Protocol/acp-cli/pull/53)
- [Issue #38](https://github.com/Virtual-Protocol/acp-cli/issues/38) -> [fix PR #52](https://github.com/Virtual-Protocol/acp-cli/pull/52)
- [Issue #39](https://github.com/Virtual-Protocol/acp-cli/issues/39) -> [fix PR #51](https://github.com/Virtual-Protocol/acp-cli/pull/51)
- [Issue #40](https://github.com/Virtual-Protocol/acp-cli/issues/40) -> [fix PR #50](https://github.com/Virtual-Protocol/acp-cli/pull/50)
`;

const finding: NewAgentFinding = {
  findingId: VIRTUALS_ACP_CLI_FINDING_ID,
  agentTokenAddress: VIRTUALS_ACP_CLI_AGENT_TOKEN,
  agentName: "Virtuals ACP CLI",
  repoFullName: "Virtual-Protocol/acp-cli",
  benchRepoName: "bench-virtuals-acp-cli",
  title:
    "4 findings: transaction-hash recovery gap, events-drain data loss, job-list crash, config durability",
  severity: "high",
  summary: SUMMARY_MD,
  evidence: EVIDENCE_MD,
  upstreamPrUrl: "https://github.com/Virtual-Protocol/acp-cli/pull/52",
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
