/**
 * Publish AntSeed finding to `agent_findings`.
 *
 * AntSeed is a P2P AI marketplace on Base — on-chain USDC payment channels,
 * an off-chain P2P payment/receipt node backend, and a local HTTPS-intercept
 * proxy CLI. Agent token 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/publish-antseed-finding.ts             # insert/update
 *   pnpm exec tsx scripts/publish-antseed-finding.ts --dry-run   # print payload only
 *   pnpm exec tsx scripts/publish-antseed-finding.ts --update \
 *     --pr-url <url> [--merged-sha <sha>]
 *
 * Reaches PROD by having the operator prefix DATABASE_URL="$PROD_DB" at
 * invocation (dotenv does NOT override an already-set env var).
 * Idempotent: re-running rewrites mutable columns but preserves publishedAt.
 *
 * Corrected 2026-07-10 after independent re-verify (prior session cited the
 * wrong contract file for finding #1 and left #2/#4 fix PRs unverified).
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

import type { NewAgentFinding } from "../db/schema";

export const ANTSEED_FINDING_ID = "antseed-bench-2026-07-10";
export const ANTSEED_AGENT_TOKEN = "0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263";

const SUMMARY_MD = `## What was found

AntFleet's two-model consensus review (Claude Opus + GPT-5) ran against
3 PRs on [\`AntFleet/bench-antseed\`](https://github.com/AntFleet/bench-antseed),
surfacing **4 findings** across AntSeed's three trust boundaries. Two of four
have **test-verified fix PRs** open upstream; the other two need maintainer
judgment (one may be intentional, one is debatable).

Independent re-verify (2026-07-10) corrected a prior-session error that
dismissed finding #1 after reading the wrong contract file.

---

### MEDIUM — Platform fee zeroed when \`protocolReserve\` is unset (on-chain) — **real, possibly intentional**

In [\`AntseedDeposits.sol\`](https://github.com/AntSeed/antseed/blob/main/packages/contracts/payments/AntseedDeposits.sol)
(\`chargeAndCreditPayouts\`, ~L186):

\`\`\`solidity
if (registry.protocolReserve() == address(0)) platformFee = 0;
\`\`\`

When \`protocolReserve\` is the zero address, the platform fee collapses to
zero and **100% of the charge is routed to the seller**. \`setProtocolReserve\`
rejects \`address(0)\`, so the exposure is the **deploy-before-config window**.
Invariant tests (\`ProtocolHandler.sol\`) model \`fee=0 when !protocolReserveSet\`,
which suggests this may be intentional fee-waiver rather than a bug.

**No fix filed** — needs maintainer decision (guard/revert vs document as
intentional). Not overstated as a critical revenue leak without that call.

---

### MEDIUM — \`getChainConfig\` silent mainnet fallback vs doc — **real, fix filed**

[\`getChainConfig\`](https://github.com/AntSeed/antseed/blob/main/packages/node/src/payments/chain-config.ts)
fell back to \`DEFAULT_CHAIN_ID\` (\`base-mainnet\`) for any unrecognized
\`chainId\`, while the doc claimed base-sepolia. A typo'd or stale id silently
resolved to mainnet config.

**Fix PR:** [AntSeed/antseed#727](https://github.com/AntSeed/antseed/pull/727)
(\`fix(chain-config): throw on unknown chainId\`). Throws on unrecognized
non-empty ids; no-arg default unchanged. Unit tests added; verified green.

---

### MEDIUM — Receipt signature omits unit price — **debatable**

[\`buildSignaturePayload\`](https://github.com/AntSeed/antseed/blob/main/packages/node/src/metering/receipt-generator.ts)
omits \`unitPriceCentsPerThousandTokens\` literally, but signs
\`costCents\` + \`totalTokens\`, which pin the effective price mathematically
(\`cost ≈ f(totalTokens, unitPrice)\`). A counterparty cannot freely invent a
different unit price without also breaking the signed cost/token pair.

**No fix filed** — maintainer judgment. Integrity of the *stated* unit-price
field is weaker than integrity of the *settlement amount*.

---

### MEDIUM — Proxy header lookups not case-insensitive — **real, fix filed**

\`getHeader\` only matched exact-lowercase and first-letter-capital variants.
Worse, load-bearing routing in \`routing.ts\` used direct
\`request.headers['x-antseed-provider']\` / \`['x-antseed-pin-peer']\` access,
so provider/peer overrides could miss mixed-case client headers.

**Fix PR:** [AntSeed/antseed#728](https://github.com/AntSeed/antseed/pull/728)
(\`fix(proxy): make header lookups truly case-insensitive\`). \`getHeader\`
exported and wired through routing + buyer-proxy; 57 proxy tests green
including 5 new case-insensitivity cases.

---

## Patch Agent product notes from this dogfood

- **#131** (merged) — verifier-first gate: cross-model agreement is a confidence
  label, not a ship veto.
- **#132** (merged) — real source in patch prompt + apply-floor; stops
  hallucinated diffs that fail \`git apply\`.
- **#133** (open) — verify-by-default: fork-standardize bench onboarding so
  \`patch-verifier\` can run against a runnable repo; repro-test generation.
`;

const EVIDENCE_MD = `- Benchmark repo: [AntFleet/bench-antseed](https://github.com/AntFleet/bench-antseed) (scaffold, not a fork — see issue #133)
- On-chain PR: [bench-antseed#1](https://github.com/AntFleet/bench-antseed/pull/1) → finding #1 (\`AntseedDeposits.sol\`)
- Off-chain PR: [bench-antseed#2](https://github.com/AntFleet/bench-antseed/pull/2) → findings #2 (chain-config), #3 (receipt unit-price)
- Proxy PR: [bench-antseed#3](https://github.com/AntFleet/bench-antseed/pull/3) → finding #4 (header case)
- Source repo: [AntSeed/antseed](https://github.com/AntSeed/antseed)
- Upstream fix #727 (chain-config, ready for review): https://github.com/AntSeed/antseed/pull/727
- Upstream fix #728 (proxy headers, ready for review): https://github.com/AntSeed/antseed/pull/728
- Agent page: https://www.antfleet.dev/agents/0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263
- Dogfood report: \`docs/demos/antseed-dogfood-2026-07.md\`
`;

const finding: NewAgentFinding = {
  findingId: ANTSEED_FINDING_ID,
  agentTokenAddress: ANTSEED_AGENT_TOKEN,
  agentName: "AntSeed",
  repoFullName: "AntSeed/antseed",
  benchRepoName: "bench-antseed",
  title: "getChainConfig silent mainnet fallback + proxy header case-sensitivity (2 fix PRs open)",
  severity: "medium",
  summary: SUMMARY_MD,
  evidence: EVIDENCE_MD,
  // Primary fix PR for the agent_findings single-URL slot; both listed in evidence.
  upstreamPrUrl: "https://github.com/AntSeed/antseed/pull/727",
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
  console.log(`  upstream_pr  : ${finding.upstreamPrUrl}`);
  console.log(
    `  db_host      : ${(process.env.DATABASE_URL || "").replace(/:[^:@/]+@/, ":***@").slice(0, 60)}`,
  );

  if (dryRun) {
    console.log("\n[dry-run] no DB write");
    console.log("\n--- summary (first 600 chars) ---");
    console.log(finding.summary.slice(0, 600));
    return;
  }

  const { upsertAgentFinding } = await import("../db/queries");
  await upsertAgentFinding(finding);
  console.log(`\n[done] upserted successfully — view at /agents/${ANTSEED_AGENT_TOKEN}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
