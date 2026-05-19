/**
 * Publish the FeeLocker selector-mismatch finding to `agent_findings`.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/publish-feelocker-finding.ts
 *   pnpm exec tsx scripts/publish-feelocker-finding.ts --update --pr-url <url>
 *   pnpm exec tsx scripts/publish-feelocker-finding.ts --update \
 *     --pr-url <url> --merged-sha <sha>
 *
 * Idempotent — re-running rewrites the row's mutable columns but preserves
 * publishedAt. The --update form is what Stage 3 of the autopilot uses to
 * patch the row with the upstream PR URL once the PR is open.
 *
 * The script is intentionally hard-coded with this single finding's body.
 * Future per-agent findings get their own publish-* script (or, when we
 * have more than ~3, a generic loader over a directory of markdown files).
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

import { upsertAgentFinding } from "../db/queries";
import type { NewAgentFinding } from "../db/schema";

export const FEELOCKER_FINDING_ID = "feelocker-selector-2026-05-18";
export const AUTONOMOPOLY_AGENT_TOKEN = "0xB3D7e0c3C39A1D3F1B304663065A2F83Ddf56d8e";

const SUMMARY_MD = `## What was wrong

The on-chain monitor in \`agent-autonomopoly\` reads its FeeLocker
balance with selector \`0xe7acab24\`, labeled in the source as
\`availableFees(address,address)\`. Calls with that selector revert
against the deployed FeeLocker at
\`0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF\` because the selector
does not exist on that contract — \`0xe7acab24\` actually resolves
to Seaport's \`fulfillAdvancedOrder(...)\`, an unrelated function.

The result is silent operational blindness: the agent cannot evaluate
its build-mode trigger ("claim 100 DIEM") against its actual claimable
balance, and any "stake more on Venice" logic that depends on
FeeLocker reads fails without raising.

## The correct selector

The real selector for \`availableFees(address,address)\` is
**\`0x8296535a\`**. Two pieces of independent evidence:

- The selector is present in the FeeLocker's deployed dispatch table
  (extracted directly from the on-chain bytecode and resolved against
  the openchain.xyz signature database).
- viem's \`toFunctionSelector("availableFees(address,address)")\`
  returns the same value — a pure keccak256 computation that does
  not depend on any signature database.

A second selector on the same contract,
\`feesToClaim(address,address)\` (\`0x8417645e\`), returns the same
value at every block we tested. The fix uses \`availableFees\`
because that is the semantic name already in the agent's code; this
is a selector correction, not a signature rename.

## Live state

At the time of publish, on Base mainnet:

\`\`\`text
availableFees(AUTONOMOPOLY, DIEM) at latest      = 1.7608 DIEM
availableFees(AUTONOMOPOLY, DIEM) at block 46143000 = 8.4516 DIEM
\`\`\`

The drop between block 46143000 and latest matches the DIEM claim
event in the agent's own daily log (\`memory/logs/2026-05-18.md\`,
section "AUTONO FeeLocker DIEM claimable"), confirming this selector
is the live claimable-balance reader.

## Reproduce

\`\`\`bash
cast call 0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF \\
  "availableFees(address,address)(uint256)" \\
  0x8767Df39eCeeaeB11554642237aC4E08660aB6A3 \\
  0xF4d97F2da56e8c3098f3a8D538DB630A2606a024 \\
  --rpc-url https://mainnet.base.org
\`\`\`

Returns \`1760804950210169625\` wei (≈ 1.7608 DIEM).

The agent's incorrect selector reverts:

\`\`\`bash
cast call 0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF \\
  0xe7acab240000000000000000000000008767Df39eCeeaeB11554642237aC4E08660aB6A3\\
000000000000000000000000F4d97F2da56e8c3098f3a8D538DB630A2606a024 \\
  --rpc-url https://mainnet.base.org
# -> execution reverted
\`\`\`
`;

const EVIDENCE_MD = `- FeeLocker contract on Base: [0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF](https://basescan.org/address/0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF)
- DIEM token on Base: [0xF4d97F2da56e8c3098f3a8D538DB630A2606a024](https://basescan.org/token/0xF4d97F2da56e8c3098f3a8D538DB630A2606a024)
- Autonomopoly agent wallet: [0x8767Df39eCeeaeB11554642237aC4E08660aB6A3](https://basescan.org/address/0x8767Df39eCeeaeB11554642237aC4E08660aB6A3)
- Bug source — agent's own log entry: \`memory/logs/2026-05-18.md\` "AUTONO FeeLocker DIEM claimable" in [Liquid-Protocol-Ops/agent-autonomopoly](https://github.com/Liquid-Protocol-Ops/agent-autonomopoly)
- Selector \`0xe7acab24\` resolves to Seaport's \`fulfillAdvancedOrder(...)\` per [openchain.xyz](https://openchain.xyz/signatures?query=0xe7acab24)
- Selector \`0x8296535a\` resolves to \`availableFees(address,address)\` per [openchain.xyz](https://openchain.xyz/signatures?query=0x8296535a)
`;

export function buildFeeLockerFinding(args: {
  upstreamPrUrl?: string | null;
  upstreamMergedSha?: string | null;
}): NewAgentFinding {
  return {
    findingId: FEELOCKER_FINDING_ID,
    agentTokenAddress: AUTONOMOPOLY_AGENT_TOKEN,
    agentName: "agent-autonomopoly",
    title:
      "FeeLocker availableFees selector mismatch — agent cannot read claimable DIEM",
    severity: "high",
    summary: SUMMARY_MD,
    evidence: EVIDENCE_MD,
    upstreamPrUrl: args.upstreamPrUrl ?? null,
    upstreamMergedSha: args.upstreamMergedSha ?? null,
  };
}

export type CliArgs = {
  update: boolean;
  prUrl: string | null;
  mergedSha: string | null;
};

export function parseArgs(argv: readonly string[]): CliArgs {
  let update = false;
  let prUrl: string | null = null;
  let mergedSha: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--update") {
      update = true;
    } else if (arg === "--pr-url") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--pr-url requires a value");
      prUrl = next;
      i++;
    } else if (arg === "--merged-sha") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--merged-sha requires a value");
      mergedSha = next;
      i++;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!update && (prUrl !== null || mergedSha !== null)) {
    throw new Error("--pr-url / --merged-sha require --update");
  }
  return { update, prUrl, mergedSha };
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const row = buildFeeLockerFinding({
    upstreamPrUrl: cli.prUrl,
    upstreamMergedSha: cli.mergedSha,
  });
  await upsertAgentFinding(row);
  console.log(
    `published agent_findings row ${row.findingId}` +
      (cli.update ? " (update)" : "") +
      (cli.prUrl !== null ? ` — pr=${cli.prUrl}` : "") +
      (cli.mergedSha !== null ? ` — merged_sha=${cli.mergedSha}` : ""),
  );
}

if (process.argv[1]?.endsWith("publish-feelocker-finding.ts")) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
