/**
 * Publish Reppo Polyagent findings to `agent_findings`.
 *
 * reppo-polyagent is a geopolitical prediction market trading agent.
 * AntFleet's two-model consensus review (Claude Opus 4.7 + GPT-5) ran 3 manual
 * file-pick PRs on AntFleet/bench-reppo-polyagent covering wallet/agent loop,
 * trading/settlement, and infra/config surfaces.
 * 4 unanimous findings (1 HIGH security, 2 medium, 1 low).
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/publish-reppo-polyagent-finding.ts             # insert/update
 *   pnpm exec tsx scripts/publish-reppo-polyagent-finding.ts --dry-run   # print payload only
 *   pnpm exec tsx scripts/publish-reppo-polyagent-finding.ts --update --pr-url <url>
 *
 * Idempotent: re-running rewrites mutable columns but preserves publishedAt.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

import type { NewAgentFinding } from "../db/schema";

export const REPPO_POLYAGENT_FINDING_ID = "reppo-polyagent-bench-2026-05-25";
export const REPPO_AGENT_TOKEN = "0x70000c1cb3ee34a7323211607ac3162665b49549";

const SUMMARY_MD = `## What was found

AntFleet's two-model consensus review (Claude Opus 4.7 + GPT-5) ran against
3 manual file-pick PRs on [\`AntFleet/bench-reppo-polyagent\`](https://github.com/AntFleet/bench-reppo-polyagent),
covering the wallet/agent loop, trading/settlement, and infrastructure configuration surfaces.

**4 unanimous findings (1 HIGH, 2 medium, 1 low):**

---

**1. [HIGH] S3 bucket disables all public access blocks — ACL over-permission risk**

The CDK stack sets all four S3 Block Public Access controls to \`False\`. Only
\`block_public_policy=False\` and \`restrict_public_buckets=False\` are needed to
allow the intended \`dashboard/*\` public-read bucket policy via a bucket policy.
Setting \`block_public_acls=False\` and \`ignore_public_acls=False\` unnecessarily
removes the ACL-based safety net, making \`geo-signals/feedback.csv\` and other
non-dashboard prefixes susceptible to accidental public exposure via a future ACL
mistake.

**Fix**: Set \`block_public_acls=True, ignore_public_acls=True\` — the dashboard
public-read policy still works, but ACL-based oversharing is blocked.
Fix PR: [Reppo-Labs/reppo-polyagent#1](https://github.com/Reppo-Labs/reppo-polyagent/pull/1). *(infra/stack.py, PR #3)*

---

**2. [medium] DynamoDB table uses hard-coded \`table_name\` — blocks multi-env deploys**

\`table_name="geo-trading-positions"\` is hard-coded in the CDK stack and duplicated
in the Lambda env var, making it impossible to deploy dev + staging in the same
AWS account/region. The Lambda env references the literal string, not the CDK
\`table.table_name\` reference, so a rename would silently break the Lambda.

**Fix**: Omit \`table_name\` (let CDK generate) and pass \`table.table_name\` to the Lambda. *(infra/stack.py, PR #3)*

---

**3. [medium] Inconsistent block handling in tool-use loop may raise \`AttributeError\`**

The agent loop uses \`getattr\` for text blocks but directly accesses
\`.type / .name / .input\` for tool blocks. If the Anthropic SDK returns
dict-based blocks (e.g., on older versions or in replay), this raises
\`AttributeError\`. *(agent/agent_loop.py, PR #1)*

---

**4. [low] csv.DictReader docstring misleadingly claims it limits columns**

The docstring in \`preprocess_signals\` states "csv.DictReader only reads the
keys above" but DictReader reads *all* columns — the function only *uses* those
keys. Misleads future maintainers about memory cost on wide CSVs. *(agent/signals.py, PR #2)*
`;

const EVIDENCE_MD = `- Benchmark repo: [AntFleet/bench-reppo-polyagent](https://github.com/AntFleet/bench-reppo-polyagent)
- Wallet + agent loop bench PR: [AntFleet/bench-reppo-polyagent#1](https://github.com/AntFleet/bench-reppo-polyagent/pull/1) (1 finding)
- Markets + settlement bench PR: [AntFleet/bench-reppo-polyagent#2](https://github.com/AntFleet/bench-reppo-polyagent/pull/2) (1 finding) · [review comment](https://github.com/AntFleet/bench-reppo-polyagent/pull/2#issuecomment-4532179978)
- Infra + config bench PR: [AntFleet/bench-reppo-polyagent#3](https://github.com/AntFleet/bench-reppo-polyagent/pull/3) (3 findings) · [review comment](https://github.com/AntFleet/bench-reppo-polyagent/pull/3#issuecomment-4532172805)
- Source repo: [Reppo-Labs/reppo-polyagent](https://github.com/Reppo-Labs/reppo-polyagent)
- Upstream fix PR: [Reppo-Labs/reppo-polyagent#1](https://github.com/Reppo-Labs/reppo-polyagent/pull/1)
- Token: [0x7000…549 on Base](https://basescan.org/token/0x70000c1cb3ee34a7323211607ac3162665b49549)
`;

const finding: NewAgentFinding = {
  findingId: REPPO_POLYAGENT_FINDING_ID,
  agentTokenAddress: REPPO_AGENT_TOKEN,
  agentName: "Reppo",
  repoFullName: "Reppo-Labs/reppo-polyagent",
  benchRepoName: "bench-reppo-polyagent",
  title: "S3 bucket over-permission + 3 additional findings across trading agent infra and loop",
  severity: "high",
  summary: SUMMARY_MD,
  evidence: EVIDENCE_MD,
  upstreamPrUrl: "https://github.com/Reppo-Labs/reppo-polyagent/pull/1",
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
