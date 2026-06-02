// Centralized env-var resolution for the paywall surface so the same
// defaults apply across the API endpoints, the deposit cron, and the
// public manifest. Throwing here is intentional — every endpoint that
// reads these values must be willing to fail loudly if the operator
// forgot to set them in prod.

export const BASE_CHAIN_ID = 8453;
export const USDC_BASE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// USDC on Base is a standard ERC-20 with 6 decimals.
export const USDC_DECIMALS = 6;
// Minimum on-chain confirmations the /deposit endpoint requires before
// crediting a channel. Base finalizes fast (~2s blocks); 3 confirms keeps
// reorg risk negligible while still letting agents proceed promptly.
export const DEPOSIT_MIN_CONFIRMATIONS = 3;

export function getReviewPriceUsdc(): string {
  return process.env["REVIEW_PRICE_USDC"] ?? "0.50";
}

// Flat price for a full-repo vulnerability scan (POST /api/v1/scan/x402).
// Mirrors the X402_REPO_SCAN_PRICE_USDC default in lib/x402/env.ts so the
// public manifest and the paywall agree on the quoted price.
export function getRepoScanPriceUsdc(): string {
  return process.env["X402_REPO_SCAN_PRICE_USDC"] ?? "2.00";
}

export function getMinDepositUsdc(): string {
  return process.env["MIN_DEPOSIT_USDC"] ?? "5.00";
}

// The Safe (or EOA) on Base that receives agent deposits. Operator-set in
// prod; the API endpoints surface a 503 when missing so an agent doesn't
// silently fund the wrong address.
export function getDepositAddress(): string | null {
  const raw = process.env["ANTFLEET_DEPOSIT_ADDRESS"];
  if (raw === undefined || raw.length === 0) return null;
  return raw.toLowerCase();
}

export function getBaseRpcUrl(): string {
  return process.env["BASE_RPC_URL"] ?? "https://mainnet.base.org";
}

// Public base URL for self-serve links surfaced in next_step blocks and
// the public manifest. Mirrors `onboarderBaseUrl()` semantics so a single
// override flips both surfaces in prod.
export function getPublicBaseUrl(): string {
  const override = process.env["ANTFLEET_PUBLIC_BASE_URL"];
  if (override !== undefined && override.length > 0) return override;
  const vercel = process.env["VERCEL_PROJECT_PRODUCTION_URL"];
  if (vercel !== undefined && vercel.length > 0) return `https://${vercel}`;
  return "http://localhost:3000";
}

export function getGitHubAppInstallUrl(): string {
  return (
    process.env["GITHUB_APP_INSTALL_URL"] ?? "https://github.com/apps/antfleet/installations/new"
  );
}
