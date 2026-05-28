/**
 * Publish Doppler agent findings to `agent_findings`.
 *
 * Doppler is a Solidity protocol for on-chain token launches (Uniswap V3/V4
 * hooks, migrators, governance). No agent token — uses a deterministic
 * placeholder address derived from the repo name.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/publish-doppler-finding.ts             # insert/update
 *   pnpm exec tsx scripts/publish-doppler-finding.ts --dry-run   # print payload only
 *   pnpm exec tsx scripts/publish-doppler-finding.ts --update \
 *     --pr-url <url> [--merged-sha <sha>]
 *
 * Idempotent: re-running rewrites mutable columns but preserves publishedAt.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

import type { NewAgentFinding } from "../db/schema";

export const DOPPLER_FINDING_ID = "doppler-bench-2026-05-23";
// Deterministic placeholder: sha256("whetstoneresearch/doppler")[:40]
export const DOPPLER_AGENT_TOKEN = "0xed5e8f9567052566d4b81513fa5ba612a43f81ed";

const SUMMARY_MD = `## What was found

AntFleet's two-model consensus review (Claude Opus 4.7 + GPT-5) ran against
3 PRs on [\`AntFleet/bench-doppler\`](https://github.com/AntFleet/bench-doppler),
surfacing **3 unanimous findings** on PR #2 (initializers, hooks, migrators).

---

### LOW — SwapRestrictorDopplerHook int128 to uint128 cast (regraded, originally HIGH)

\`SwapRestrictorDopplerHook._onSwap\` casts \`balanceDelta.amount0()\` (int128)
directly to \`uint128\`. The two-model consensus originally graded this HIGH,
claiming a negative delta would wrap to ~2^128 and disable the per-address
buy cap.

**Regraded to LOW after maintainer pushback on
[whetstoneresearch/doppler#521](https://github.com/whetstoneresearch/doppler/pull/521).**
The cast sits inside the \`params.zeroForOne != isToken0\` branch, which only
runs when the asset is the swap *output*. Uniswap V4 keeps the BalanceDelta
positive on the output side, so the wraparound the report described cannot
occur in normal swap semantics. The fix PR was closed without merge as not
a real issue. The proposed \`require(assetDelta > 0)\` remains a benign
defense-in-depth hardening but is not a security fix.

---

### CRITICAL (withdrawn) — RehypeDopplerHookMigrator buyback currency mismatch

Both asset-buyback and numeraire-buyback branches transfer using
\`Currency.wrap(asset)\`. Reviewer withdrew finding after re-checking the
swap direction logic — the currency routing is correct given the swap path.

---

### PR #1 (core contracts) and PR #3 (governance, tokens) — clean

No consensus findings on Airlock, Bundler, lockers, base contracts,
governance, token factories, or DN404.
`;

const EVIDENCE_MD = `- Benchmark repo: [AntFleet/bench-doppler](https://github.com/AntFleet/bench-doppler)
- Initializers/hooks bench PR: [AntFleet/bench-doppler#2](https://github.com/AntFleet/bench-doppler/pull/2) (3 findings)
- Core contracts bench PR: [AntFleet/bench-doppler#1](https://github.com/AntFleet/bench-doppler/pull/1) (0 findings — clean)
- Governance/tokens bench PR: [AntFleet/bench-doppler#3](https://github.com/AntFleet/bench-doppler/pull/3) (0 findings — clean)
- Source repo: [whetstoneresearch/doppler](https://github.com/whetstoneresearch/doppler)
- Upstream fix PR: [whetstoneresearch/doppler#521](https://github.com/whetstoneresearch/doppler/pull/521) — closed without merge; maintainer (Cooper Kunz) noted asset-side BalanceDelta is always positive when the asset is bought, so the wraparound is unreachable. Regraded HIGH → LOW.
`;

const finding: NewAgentFinding = {
  findingId: DOPPLER_FINDING_ID,
  agentTokenAddress: DOPPLER_AGENT_TOKEN,
  agentName: "Doppler",
  repoFullName: "whetstoneresearch/doppler",
  benchRepoName: "bench-doppler",
  title: "int128 to uint128 cast in SwapRestrictorDopplerHook (regraded LOW; defense-in-depth)",
  severity: "low",
  summary: SUMMARY_MD,
  evidence: EVIDENCE_MD,
  upstreamPrUrl: "https://github.com/whetstoneresearch/doppler/pull/521",
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
  console.log(`\n[done] upserted successfully — view at /agents/${DOPPLER_AGENT_TOKEN}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
