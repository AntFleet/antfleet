/**
 * Publish Bitterbot finding to `agent_findings`.
 *
 * Bitterbot is a TypeScript desktop AI agent with wallet, skills marketplace,
 * and P2P relay fleet. No agent token — uses a deterministic placeholder
 * address derived from the repo name.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/publish-bitterbot-finding.ts             # insert/update
 *   pnpm exec tsx scripts/publish-bitterbot-finding.ts --dry-run   # print payload only
 *   pnpm exec tsx scripts/publish-bitterbot-finding.ts --update \
 *     --pr-url <url> [--merged-sha <sha>]
 *
 * Idempotent: re-running rewrites mutable columns but preserves publishedAt.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

import type { NewAgentFinding } from "../db/schema";

export const BITTERBOT_FINDING_ID = "bitterbot-bench-2026-05-28";
// Deterministic placeholder: sha256("Bitterbot-AI/bitterbot-desktop")[:40]
export const BITTERBOT_AGENT_TOKEN = "0x12e4dd4ae6e0fe874a99b11c62039b446043653b";

const SUMMARY_MD = `## What was found

AntFleet's two-model consensus review (Claude Opus 4.7 + GPT-5) ran against
3 PRs on [\`AntFleet/bench-bitterbot-desktop\`](https://github.com/AntFleet/bench-bitterbot-desktop),
surfacing **3 unanimous findings** across the wallet and inbound access-control surfaces.

---

### HIGH — Inbound allowlist compares normalized list against unnormalized candidates

In \`checkInboundAccessControl\` (\`src/web/inbound/access-control.ts\`), the
allowlist entries are normalized via \`normalizeE164\` but the incoming \`params.from\`
and \`params.senderE164\` values are compared raw. A sender stored as
\`"14155551234"\` in the allowlist will not match an inbound \`"+1 415-555-1234"\`,
silently blocking legitimate users. The \`isSamePhone\` self-chat check has
the same issue.

**Fix:** normalize candidates before comparison:
\`\`\`ts
const candidate = normalizeE164(params.from);
const candidateSender = params.senderE164 ? normalizeE164(params.senderE164) : null;
const isSamePhone = normalizeE164(params.from) === normalizeE164(params.selfE164 ?? "");
\`\`\`

---

### MEDIUM — Fund wallet URL contains unencoded JSON breaking Coinbase Pay link

The \`handleFundWallet\` fallback in \`WalletView.tsx\` constructs the Coinbase Pay
URL by interpolating raw JSON (braces, quotes, brackets) directly into the query
string. Coinbase Pay requires \`addresses\` and \`assets\` to be URL-encoded JSON.
The unencoded form is non-conformant and may be rejected at Coinbase's side.

**Fix:**
\`\`\`ts
const params = new URLSearchParams({
  addresses: JSON.stringify({ [address]: ["base"] }),
  assets: JSON.stringify(["USDC"]),
});
window.open(\`https://pay.coinbase.com/buy?\${params}\`, "_blank");
\`\`\`

---

### LOW — wallet-store \`setConfig\` never called; WalletView duplicates config in local state

\`wallet-store.ts\` exposes \`config\` and \`setConfig\` but \`WalletView\` keeps wallet
config in a local \`useState\`, leaving the store permanently \`null\`. Sidebar
and other consumers cannot read caps from the store.

---

### PR #2 (auth / key management) — clean

No unanimous findings on OAuth profiles, session override, profile store, or
live auth key management.
`;

const EVIDENCE_MD = `- Benchmark repo: [AntFleet/bench-bitterbot-desktop](https://github.com/AntFleet/bench-bitterbot-desktop)
- Wallet layer bench PR: [AntFleet/bench-bitterbot-desktop#1](https://github.com/AntFleet/bench-bitterbot-desktop/pull/1) (2 findings)
- Auth / key management bench PR: [AntFleet/bench-bitterbot-desktop#2](https://github.com/AntFleet/bench-bitterbot-desktop/pull/2) (0 findings — clean)
- Web inbound / access control bench PR: [AntFleet/bench-bitterbot-desktop#3](https://github.com/AntFleet/bench-bitterbot-desktop/pull/3) (1 finding)
- Source repo: [Bitterbot-AI/bitterbot-desktop](https://github.com/Bitterbot-AI/bitterbot-desktop)
`;

const finding: NewAgentFinding = {
  findingId: BITTERBOT_FINDING_ID,
  agentTokenAddress: BITTERBOT_AGENT_TOKEN,
  agentName: "Bitterbot",
  repoFullName: "Bitterbot-AI/bitterbot-desktop",
  benchRepoName: "bench-bitterbot-desktop",
  title:
    "Inbound allowlist compares normalized list against unnormalized phone candidates (mis-blocks legitimate senders)",
  severity: "high",
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
  console.log(`\n[done] upserted successfully — view at /agents/${BITTERBOT_AGENT_TOKEN}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
