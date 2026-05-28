/**
 * Publish gitlawb_openclaude agent findings to `agent_findings`.
 *
 * openclaude is a TypeScript CLI agent framework (27.5k stars). AntFleet's
 * two-model consensus review found 0 unanimous findings across 3 PRs —
 * clean review.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/publish-openclaude-finding.ts             # insert/update
 *   pnpm exec tsx scripts/publish-openclaude-finding.ts --dry-run   # print payload only
 *
 * Idempotent: re-running rewrites mutable columns but preserves publishedAt.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

import type { NewAgentFinding } from "../db/schema";

export const OPENCLAUDE_FINDING_ID = "openclaude-bench-2026-05-23";
export const OPENCLAUDE_AGENT_TOKEN = "0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3";

const SUMMARY_MD = `## What was found

AntFleet's two-model consensus review (Claude Opus 4.7 + GPT-5) ran against
3 PRs on [\`AntFleet/bench-openclaude\`](https://github.com/AntFleet/bench-openclaude),
covering the bridge/auth/session layer, server/remote/gRPC surface, and
plugin/hook/skill extensibility layer.

**0 unanimous findings** — both models reviewed the code independently and
did not agree on any security, bug, or correctness issues across 31 files.

This is a clean review. The bridge layer's JWT handling, session management,
trusted device flow, and remote WebSocket sessions passed without consensus
flags. The Python smart router and provider discovery scripts also cleared.

A clean result from AntFleet's two-model consensus pipeline means neither
Claude Opus 4.7 nor GPT-5 independently flagged the same issue — the bar
for a finding is both models agreeing on the same defect.
`;

const EVIDENCE_MD = `- Benchmark repo: [AntFleet/bench-openclaude](https://github.com/AntFleet/bench-openclaude)
- Bridge/auth bench PR: [AntFleet/bench-openclaude#1](https://github.com/AntFleet/bench-openclaude/pull/1) (0 findings)
- Server/remote bench PR: [AntFleet/bench-openclaude#2](https://github.com/AntFleet/bench-openclaude/pull/2) (0 findings)
- Plugins/hooks bench PR: [AntFleet/bench-openclaude#3](https://github.com/AntFleet/bench-openclaude/pull/3) (0 findings)
- Source repo: [Gitlawb/openclaude](https://github.com/Gitlawb/openclaude)
- Token: [0x5f98…ba3 on Base](https://basescan.org/token/0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3)
`;

const finding: NewAgentFinding = {
  findingId: OPENCLAUDE_FINDING_ID,
  agentTokenAddress: OPENCLAUDE_AGENT_TOKEN,
  agentName: "gitlawb_openclaude",
  repoFullName: "Gitlawb/openclaude",
  benchRepoName: "bench-openclaude",
  title: "Clean review — 0 unanimous findings across bridge, server, and extensibility layers",
  severity: "info",
  summary: SUMMARY_MD,
  evidence: EVIDENCE_MD,
  upstreamPrUrl: null,
  upstreamMergedSha: null,
};

async function main() {
  const dryRun = process.argv.includes("--dry-run");

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
  console.log(`\n[done] upserted successfully — view at /agents/${OPENCLAUDE_AGENT_TOKEN}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
