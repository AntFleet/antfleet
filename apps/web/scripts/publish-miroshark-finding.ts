/**
 * Publish MiroShark agent stub to `agent_findings`.
 *
 * MiroShark is a universal swarm intelligence simulation engine on Base.
 * This creates the /agents/[address] page so AntFleet can populate
 * receipts and findings as bench reviews are run.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/publish-miroshark-finding.ts             # insert/update
 *   pnpm exec tsx scripts/publish-miroshark-finding.ts --dry-run   # print payload only
 *   pnpm exec tsx scripts/publish-miroshark-finding.ts --update \
 *     --pr-url <url> [--merged-sha <sha>]
 *
 * Idempotent: re-running rewrites mutable columns but preserves publishedAt.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

import type { NewAgentFinding } from "../db/schema";

export const MIROSHARK_FINDING_ID = "miroshark-bench-2026-05-23";
export const MIROSHARK_AGENT_TOKEN = "0xd7bc6a05a56655fb2052f742b012d1dfd66e1ba3";

const SUMMARY_MD = `## About MiroShark

[MiroShark](https://github.com/aaronjmars/MiroShark) is a universal swarm
intelligence simulation engine — drop in any scenario and it spawns hundreds
of grounded agents that react hour by hour across simulated Twitter, Reddit,
and prediction markets.

- **1,191 stars** on GitHub
- Python + Node stack (Neo4j graph backend)
- Supports OpenRouter, Ollama, Claude Code CLI, Docker, Railway/Render deploy
- Features: Smart Setup, What's Trending (RSS), Just Ask, mid-run news injection, timeline forking

AntFleet has registered MiroShark for benchmark review. Findings will be
published here as PRs are reviewed through the two-model consensus pipeline.
`;

const EVIDENCE_MD = `- Source repo: [aaronjmars/MiroShark](https://github.com/aaronjmars/MiroShark)
- Token: [0xd7bc…1ba3 on Base](https://basescan.org/token/0xd7bc6a05a56655fb2052f742b012d1dfd66e1ba3)
- Bankr listing: [bankr.bot/discover/0xd7bc…](https://bankr.bot/discover/0xd7bc6a05a56655fb2052f742b012d1dfd66e1ba3)
`;

const finding: NewAgentFinding = {
  findingId: MIROSHARK_FINDING_ID,
  agentTokenAddress: MIROSHARK_AGENT_TOKEN,
  agentName: "MiroShark",
  repoFullName: "aaronjmars/MiroShark",
  benchRepoName: null,
  title: "AntFleet benchmark subject — findings pending",
  severity: "info",
  summary: SUMMARY_MD,
  evidence: EVIDENCE_MD,
  upstreamPrUrl: null,
  upstreamMergedSha: null,
};

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const update = process.argv.includes("--update");

  if (update) {
    const prUrlIdx = process.argv.indexOf("--pr-url");
    const prUrl = prUrlIdx !== -1 ? process.argv[prUrlIdx + 1] : undefined;
    const shaIdx = process.argv.indexOf("--merged-sha");
    const sha = shaIdx !== -1 ? process.argv[shaIdx + 1] : undefined;
    if (prUrl) finding.upstreamPrUrl = prUrl;
    if (sha) finding.upstreamMergedSha = sha;
  }

  console.log("\n[finding payload]");
  console.log(`  finding_id   : ${finding.findingId}`);
  console.log(`  agent_token  : ${finding.agentTokenAddress}`);
  console.log(`  agent_name   : ${finding.agentName}`);
  console.log(`  repo         : ${finding.repoFullName}`);
  console.log(`  severity     : ${finding.severity}`);
  console.log(`  title        : ${finding.title}`);

  if (dryRun) {
    console.log("\n[dry-run] no DB write");
    return;
  }

  const { upsertAgentFinding } = await import("../db/queries");
  await upsertAgentFinding(finding);
  console.log("\n[done] upserted successfully — view at /agents/0xd7bc6a05a56655fb2052f742b012d1dfd66e1ba3");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
