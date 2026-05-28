/**
 * Publish Mythos Router findings to `agent_findings`.
 *
 * mythos-router is a TypeScript AI agent router CLI (174 stars) implementing
 * Strict Write Discipline with adaptive Claude Opus 4.7 thinking.
 * AntFleet's two-model consensus review (Claude Opus 4.7 + GPT-5) ran 3 manual
 * file-pick PRs on AntFleet/bench-mythos-router covering session/security/config,
 * provider clients, and orchestrator/budget/CI surfaces.
 * 5 unanimous findings (1 HIGH security, 4 medium).
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/publish-mythos-router-finding.ts             # insert/update
 *   pnpm exec tsx scripts/publish-mythos-router-finding.ts --dry-run   # print payload only
 *   pnpm exec tsx scripts/publish-mythos-router-finding.ts --update --pr-url <url>
 *
 * Idempotent: re-running rewrites mutable columns but preserves publishedAt.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

import type { NewAgentFinding } from "../db/schema";

export const MYTHOS_ROUTER_FINDING_ID = "mythos-router-bench-2026-05-26";
export const MYTHOS_ROUTER_TOKEN = "0xb942b75a602fa318ac091370d93d9143ba345ba3";

const SUMMARY_MD = `## What was found

AntFleet's two-model consensus review (Claude Opus 4.7 + GPT-5) ran against
3 manual file-pick PRs on [\`AntFleet/bench-mythos-router\`](https://github.com/AntFleet/bench-mythos-router),
covering the session/security/config layer, provider clients, and orchestrator/budget/CI surface.

**5 unanimous findings (1 HIGH, 4 medium):**

---

**1. [HIGH] Security policy bypassed by subdirectory-placed sensitive files**

The regexes in \`security-policy.ts\` for \`.env\`, \`.npmrc\`, \`.git\`, \`.ssh\`, \`Dockerfile\`,
\`scripts/\`, etc. are anchored to the start of the path — they only flag files at the
repository root. Sensitive files placed in subdirectories (e.g. \`apps/api/.env\`,
\`packages/foo/.npmrc\`, \`services/web/Dockerfile\`) will not match and are
misclassified as safe, bypassing block/confirmation guards.

**Fix:** Use non-anchored prefix-boundary patterns, e.g. \`/(?:^|/)\\.env(?:\\.|$)/i\` instead
of \`/^\\.env/i\`. *(src/security-policy.ts:16-27)*

---

**2. [medium] Telemetry retention keeps RETENTION_LIMIT+1 rows (off-by-one)**

\`id < (MAX(id) - LIMIT)\` retains rows with \`id >= MAX - LIMIT\`, which is LIMIT+1 rows
(inclusive range). The condition should use \`<=\` to keep exactly RETENTION_LIMIT rows.
*(src/providers/telemetry.ts:206-214)*

---

**3. [medium] \`getModelPricing\` JSDoc contradicts implementation — never returns null**

The JSDoc promises \`null\` for unknown models, but the implementation always returns a
fallback-derived object. Callers may write null-guards that never fire, or assume returned
values are known rates when they are conservative estimates. *(src/providers/pricing.ts:62-66)*

---

**4. [medium] Circuit breaker trips on first retry exhaustion — too aggressive**

\`retryWithBackoff\` trips the circuit breaker after 3 attempts and throws. The caller
then marks \`fallbackTriggered\` and continues to the next provider. A single transient
burst (e.g. brief 503) marks a provider degraded for 5 minutes after just one failed
call sequence — contrary to typical failure-rate-based circuit breaker semantics.
*(src/providers/orchestrator.ts:263-305)*

---

**5. [medium] Budget config accepts zero/negative/NaN — propagates to Infinity and inconsistent state**

No validation prevents invalid values for \`maxTokens\`, \`maxTurns\`, or cost fields.
Division by zero yields \`Infinity\`; NaN propagates through percentages; negative values
produce nonsensical snapshots. \`record\`/\`restore\` also allow invalid inputs.
*(src/budget.ts:58-68)*
`;

const EVIDENCE_MD = `- Benchmark repo: [AntFleet/bench-mythos-router](https://github.com/AntFleet/bench-mythos-router)
- Session/security/config bench PR: [AntFleet/bench-mythos-router#1](https://github.com/AntFleet/bench-mythos-router/pull/1) (1 finding) · [review comment](https://github.com/AntFleet/bench-mythos-router/pull/1#issuecomment-4540075492)
- Providers bench PR: [AntFleet/bench-mythos-router#2](https://github.com/AntFleet/bench-mythos-router/pull/2) (2 findings) · [review comment](https://github.com/AntFleet/bench-mythos-router/pull/2#issuecomment-4540078216)
- Orchestrator/budget/CI bench PR: [AntFleet/bench-mythos-router#3](https://github.com/AntFleet/bench-mythos-router/pull/3) (2 findings) · [review comment](https://github.com/AntFleet/bench-mythos-router/pull/3#issuecomment-4540078355)
- Source repo: [thewaltero/mythos-router](https://github.com/thewaltero/mythos-router)
- Token: [0xb942…ba3 on Base](https://basescan.org/token/0xb942b75a602fa318ac091370d93d9143ba345ba3)
`;

const finding: NewAgentFinding = {
  findingId: MYTHOS_ROUTER_FINDING_ID,
  agentTokenAddress: MYTHOS_ROUTER_TOKEN,
  agentName: "mythos-router",
  repoFullName: "thewaltero/mythos-router",
  benchRepoName: "bench-mythos-router",
  title:
    "Security policy subdirectory bypass + 4 additional findings across provider and budget layers",
  severity: "high",
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
  const shaIdx = args.indexOf("--merged-sha");
  if (update && prUrlIdx !== -1) {
    finding.upstreamPrUrl = args[prUrlIdx + 1] ?? null;
  }
  if (update && shaIdx !== -1) {
    finding.upstreamMergedSha = args[shaIdx + 1] ?? null;
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
  console.log(`\n[done] upserted successfully — view at /agents/${MYTHOS_ROUTER_TOKEN}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
