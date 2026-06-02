// Machine-readable service manifest for autonomous agents. Mirrors the
// agent-facing portion of llms.txt as structured JSON so an agent can
// resolve the deposit address, prices, and endpoint URLs without scraping
// markdown. Schema-stable: additions are minor versions, removals are
// breaking.

import {
  BASE_CHAIN_ID,
  getDepositAddress,
  getGitHubAppInstallUrl,
  getMinDepositUsdc,
  getPublicBaseUrl,
  getRepoScanPriceUsdc,
  getReviewPriceUsdc,
  USDC_BASE_ADDRESS,
} from "@/lib/paywall/env";
import { NO_STORE } from "@/lib/api-v1/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const base = getPublicBaseUrl();
  const manifest = {
    service: "antfleet",
    version: 1,
    description:
      "Two-model GitHub PR code review with per-review USDC settlement on Base. x402 pay-per-review for public repos; prepaid wallet-bound channels for installed/private repos.",
    chain_id: BASE_CHAIN_ID,
    payment_token: {
      address: USDC_BASE_ADDRESS,
      symbol: "USDC",
      decimals: 6,
    },
    price_per_review_usdc: getReviewPriceUsdc(),
    min_deposit_usdc: getMinDepositUsdc(),
    deposit_address: getDepositAddress(),
    github_app_install_url: getGitHubAppInstallUrl(),
    endpoints: {
      create_installation: `${base}/api/v1/installations`,
      bind_wallet: `${base}/api/v1/installations/{id}/bind`,
      submit_deposit: `${base}/api/v1/installations/{id}/deposit`,
      get_installation: `${base}/api/v1/installations/{id}`,
      review_x402: {
        url: `${base}/api/v1/review/x402`,
        access_scope: "public",
      },
      get_x402_review: {
        url: `${base}/api/v1/review/x402/{jobId}`,
        access_scope: "public",
      },
      scan_x402: {
        url: `${base}/api/v1/scan/x402`,
        access_scope: "public",
        price_usdc: getRepoScanPriceUsdc(),
        description: "Full-repo vulnerability scan, semantic chunking, two-model consensus",
      },
      llms_txt: `${base}/llms.txt`,
      manifest: `${base}/.well-known/antfleet.json`,
    },
    docs: {
      llms_txt: `${base}/llms.txt`,
      receipts: `${base}/receipts`,
    },
  };
  return new Response(JSON.stringify(manifest, null, 2), {
    status: 200,
    headers: {
      "Cache-Control": NO_STORE,
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
