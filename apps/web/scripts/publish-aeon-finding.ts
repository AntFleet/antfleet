/**
 * Publish the aeon agent findings to `agent_findings`.
 *
 * Aeon is an autonomous AI agent. AntFleet reviewed its source on
 * antfleet/aeon-bench. The primary finding is a missing auth gate on
 * secret-management endpoints.
 *
 * Usage (from project root or apps/web):
 *   pnpm exec tsx scripts/publish-aeon-finding.ts             # insert / update
 *   pnpm exec tsx scripts/publish-aeon-finding.ts --dry-run   # print payload only
 *
 * Idempotent: re-running rewrites mutable columns but preserves publishedAt.
 * Reads DATABASE_URL from apps/web/.env.local.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

import type { NewAgentFinding } from "../db/schema";

export const AEON_FINDING_ID = "aeon-secret-auth-2026-05-18";
export const AEON_AGENT_TOKEN = "0xbf8e8f0e8866a7052f948c16508644347c57aba3";

const SUMMARY_MD = `## What was wrong

AntFleet's benchmark review of \`antfleet/aeon-bench\` (PR #25, commit
\`37d0c07\`) flagged two related security gaps in aeon's secret management
layer:

**1. Unauthenticated secret-management endpoints**

The endpoint handling \`claude setup-token\` and related credential operations
accepted requests without authentication or authorization checks. An adversary
with network access to the agent process could enumerate or overwrite API keys
(Anthropic, OpenAI, Venice, etc.) without presenting any credential.

**2. Token reassembly can splice non-printable bytes**

The token-reassembly routine in \`claude setup-token\` splits and rejoins token
parts without sanitizing the intermediate segments. A crafted payload could
inject control characters or ANSI escape sequences into the stored credential,
causing the agent to ship a malformed key or be confused into logging secrets.

## Impact

Both gaps affect an agent that runs autonomously on behalf of its operator.
A compromised key store silently redirects the agent's AI calls to an
attacker-controlled endpoint or exhausts the operator's API budget without
detection.

## Additional findings (same benchmark run)

- **PR #21**: Undefined \`FORK_DEFAULT_BRANCH\` causes the agent to fetch
  \`aeon.yml\` from the wrong branch during fork operations, silently using
  stale workflow configuration.
- **PR #23**: Sharp-move dedup window violates idempotency under same-minute
  replays — a timing edge case that can cause duplicate trade signals.
- **PR #28**: Basescan claim "no key needed for source fetch" is likely wrong;
  the endpoint requires a key under certain rate-limit conditions (open finding).

## Benchmark artifact

All findings emerged from AntFleet's two-model consensus review pipeline
(Claude Opus + GPT-5) running against the public benchmark mirror
\`antfleet/aeon-bench\`. The bench contains real commits replayed as PRs;
no synthetic diffs were used.
`;

const EVIDENCE_MD = `- Benchmark repo: [antfleet/aeon-bench](https://github.com/AntFleet/aeon-bench)
- Source PR: [antfleet/aeon-bench#25](https://github.com/AntFleet/aeon-bench/pull/25)
- Review commit: \`37d0c07b30c051e368da12b053d89030eb45fee9\`
- Internal review ID: \`6017bf3f-1629-4f62-87d4-8a0b92b71c37\`
`;

const finding: NewAgentFinding = {
  findingId: AEON_FINDING_ID,
  agentTokenAddress: AEON_AGENT_TOKEN,
  agentName: "aeon",
  repoFullName: null,
  benchRepoName: "aeon-bench",
  title: "Missing auth on secret-management endpoints + token reassembly injection risk",
  severity: "high",
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
  console.log(`  severity     : ${finding.severity}`);
  console.log(`  title        : ${finding.title}`);

  if (dryRun) {
    console.log("\n[dry-run] no DB write");
    return;
  }

  const { upsertAgentFinding } = await import("../db/queries");
  await upsertAgentFinding(finding);
  console.log("\n[done] upserted successfully");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
