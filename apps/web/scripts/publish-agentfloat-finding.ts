/**
 * Publish agentfloat findings to `agent_findings`.
 *
 * agentfloat is a Uniswap v4 hook / autonomous yield-routing agent on X Layer.
 * AntFleet reviewed 3 replay PRs on AntFleet/bench-agentfloat covering
 * mainnet guardrails, deployment path, and strategy/vault hardening.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/publish-agentfloat-finding.ts
 *   pnpm exec tsx scripts/publish-agentfloat-finding.ts --dry-run
 *
 * Idempotent: re-running rewrites mutable columns but preserves publishedAt.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

import type { NewAgentFinding } from "../db/schema";

export const AGENTFLOAT_FINDING_ID = "agentfloat-bench-2026-05-31";
export const AGENTFLOAT_AGENT_TOKEN = "0xa612beda982e1b9b488a3b6563411343639c5ba3";

const SUMMARY_MD = `## What was found

AntFleet's two-model consensus review (Claude Opus 4.7 + GPT-5) ran against
3 replay PRs on [\`AntFleet/bench-agentfloat\`](https://github.com/AntFleet/bench-agentfloat),
covering mainnet agent guardrails, the X Layer deployment path, and
strategy/vault hardening.

PR #1 and PR #2 produced **0 unanimous findings**. PR #3 produced
**5 unanimous findings**:

---

**1. [HIGH] Watcher always uses testnet chain config regardless of \`CONFIG.chainId\`**

\`startWatcher\` detects mainnet mode, but constructs its viem client with the
testnet chain config and default transport. On mainnet this can make the agent
poll testnet state while logs and docs indicate mainnet operation.

**Fix**: choose chain and transport from \`CONFIG.chainId\` / \`CONFIG.rpcUrl\`,
and add a regression test proving the watcher uses the configured RPC.

---

**2. [HIGH] \`FloatVault.withdraw\` ignores strategy \`actualOut\`**

\`FloatVault.withdraw\` calls the active strategy and ignores the amount the
strategy actually returned, then attempts to transfer the requested amount to
the caller. Under rounding, stress, or partial strategy liquidity, this can
revert or mis-account vault funds.

**Fix**: transfer/account using the strategy return value, or explicitly revert
when the vault cannot satisfy the requested amount.

---

**3. [MEDIUM] \`AgentFloatHook._beforeSwap\` uses regular \`approve\` on USDT-style tokens**

The mainnet underlying is USDT-style, and the fallback path already uses
\`forceApprove\`. The transient-storage branch still uses plain
\`approve(poolManager, recallAmount)\`, which can revert on a second non-zero
allowance update.

**Fix**: use \`forceApprove\` in both \`_beforeSwap\` branches.

---

**4. [MEDIUM] CORS defaults to \`*\` while credentials are enabled**

When \`DASHBOARD_ORIGIN\` is unset, the API emits
\`Access-Control-Allow-Origin: *\` together with
\`Access-Control-Allow-Credentials: true\`. That combination is invalid in
browsers and expands the risk envelope for admin endpoints if credentialed
access is later introduced or proxied differently.

**Fix**: allow credentials only for a validated allowlist origin, or do not
emit credentialed CORS headers for wildcard origin.

---

**5. [LOW] API state reports stale Forge test counts**

The README/pitch materials claim 13/13 Forge tests passing, but
\`/api/state\` hardcodes \`testsPassed=8\` and \`testsTotal=8\`, so the dashboard
can contradict the public verification narrative.

**Fix**: remove the hardcoded fields or source them from a generated test
artifact.
`;

const EVIDENCE_MD = `- Benchmark repo: [AntFleet/bench-agentfloat](https://github.com/AntFleet/bench-agentfloat)
- Mainnet guardrails bench PR: [AntFleet/bench-agentfloat#1](https://github.com/AntFleet/bench-agentfloat/pull/1) (0 unanimous findings)
- Mainnet deploy path bench PR: [AntFleet/bench-agentfloat#2](https://github.com/AntFleet/bench-agentfloat/pull/2) (0 unanimous findings)
- Strategy/vault hardening bench PR: [AntFleet/bench-agentfloat#3](https://github.com/AntFleet/bench-agentfloat/pull/3) (5 findings) - [review comment](https://github.com/AntFleet/bench-agentfloat/pull/3#issuecomment-4588583467)
- Source repo: [ronkenx9/agentfloat-hook](https://github.com/ronkenx9/agentfloat-hook)
- Token: [0xa612...5ba3 on Base](https://basescan.org/token/0xa612beda982e1b9b488a3b6563411343639c5ba3)
`;

const finding: NewAgentFinding = {
  findingId: AGENTFLOAT_FINDING_ID,
  agentTokenAddress: AGENTFLOAT_AGENT_TOKEN,
  agentName: "agentfloat",
  repoFullName: "ronkenx9/agentfloat-hook",
  benchRepoName: "bench-agentfloat",
  title: "Mainnet watcher and vault withdrawal bugs plus 3 additional AgentFloat findings",
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
  console.log(`  repo         : ${finding.repoFullName}`);
  console.log(`  severity     : ${finding.severity}`);
  console.log(`  title        : ${finding.title}`);

  if (dryRun) {
    console.log("\n[dry-run] no DB write");
    return;
  }

  const { upsertAgentFinding } = await import("../db/queries");
  await upsertAgentFinding(finding);
  console.log(`\n[done] upserted successfully - view at /agents/${AGENTFLOAT_AGENT_TOKEN}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
