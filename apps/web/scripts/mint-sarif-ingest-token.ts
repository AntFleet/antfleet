#!/usr/bin/env tsx
// Mint a short-lived (5-min) SARIF ingest Bearer token for a specific
// (installationId, owner, repo). Operators run this when issuing a
// customer-driven SARIF upload — they hand the printed token to the
// customer, who curl-POSTs to /api/repos/{owner}/{repo}/sarif with
// `Authorization: Bearer <token>` before the TTL elapses.
//
// Tokens are one-shot: the JTI is consumed by the route on first use,
// replays return 401 via the sarif_ingest_token_use side table.
//
// Usage:
//   ANTFLEET_SARIF_INGEST_HMAC_SECRET=<secret> \
//     pnpm exec tsx apps/web/scripts/mint-sarif-ingest-token.ts \
//       --installation 133030324 --owner AntFleet --repo bench-orlixai
//
// The HMAC secret MUST match ANTFLEET_SARIF_INGEST_HMAC_SECRET set in the
// Vercel prod environment. Source it via `vercel env pull` first.

import { signSarifIngestToken } from "../lib/sarif-auth-token";

export type Parsed = {
  installationId: number;
  owner: string;
  repo: string;
};

export function parseArgs(argv: ReadonlyArray<string>): Parsed | null {
  const out: Partial<Parsed> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) break;
    if (flag === "--installation" || flag === "-i") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) out.installationId = parsed;
      i += 1;
      continue;
    }
    if (flag === "--owner" || flag === "-o") {
      out.owner = value;
      i += 1;
      continue;
    }
    if (flag === "--repo" || flag === "-r") {
      out.repo = value;
      i += 1;
      continue;
    }
  }
  if (
    out.installationId === undefined ||
    out.owner === undefined ||
    out.repo === undefined ||
    out.owner.length === 0 ||
    out.repo.length === 0
  ) {
    return null;
  }
  return out as Parsed;
}

function usage(): void {
  console.error(
    "Usage: pnpm exec tsx apps/web/scripts/mint-sarif-ingest-token.ts " +
      "--installation <id> --owner <owner> --repo <repo>",
  );
  console.error("Requires ANTFLEET_SARIF_INGEST_HMAC_SECRET in the environment.");
}

export function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === null) {
    usage();
    process.exit(1);
  }
  if ((process.env["ANTFLEET_SARIF_INGEST_HMAC_SECRET"] ?? "").length === 0) {
    console.error("ANTFLEET_SARIF_INGEST_HMAC_SECRET not set.");
    process.exit(1);
  }
  const token = signSarifIngestToken({
    installationId: parsed.installationId,
    owner: parsed.owner,
    repo: parsed.repo,
  });
  // Print only the token on stdout so callers can `$(...)` it.
  process.stdout.write(`${token}\n`);
  console.error(
    `# token valid 5 minutes for installation=${parsed.installationId} ${parsed.owner}/${parsed.repo}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
