import { getAddress, isAddress } from "viem";

export const X402_MAINNET_NETWORK = "eip155:8453";
export const X402_SEPOLIA_NETWORK = "eip155:84532";
export const X402_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const X402_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const X402_MAINNET_FACILITATOR = "https://api.cdp.coinbase.com/platform/v2/x402";
export const X402_SEPOLIA_FACILITATOR = "https://x402.org/facilitator";
export const X402_MAX_TIMEOUT_SECONDS = 600;
export const X402_AUTHORIZATION_MAX_SECONDS = 900;
export const X402_FUTURE_SKEW_SECONDS = 30;

export type X402Config = {
  network: typeof X402_MAINNET_NETWORK | typeof X402_SEPOLIA_NETWORK;
  usdcAsset: string;
  facilitator: string;
  treasury: string;
  priceUsdc: string;
  priceBaseUnits: string;
  // Flat price for a full-repo vulnerability scan (POST /api/v1/scan/x402),
  // independent of the per-PR review price. Sourced from
  // X402_REPO_SCAN_PRICE_USDC, default "2.00".
  repoScanPriceUsdc: string;
  repoScanPriceBaseUnits: string;
  cdpApiKeyId: string | null;
  cdpApiKeySecret: string | null;
};

export class X402ConfigError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type EnvMap = Record<string, string | undefined>;

const probedFacilitators = new Set<string>();

export function loadX402Config(env: EnvMap = process.env): X402Config {
  const network = requireEnv(env, "X402_NETWORK");
  if (network !== X402_MAINNET_NETWORK && network !== X402_SEPOLIA_NETWORK) {
    throw new X402ConfigError(
      "x402_network_unsupported",
      "X402_NETWORK must be eip155:8453 or eip155:84532",
    );
  }

  const usdcAsset = checksumAddress(requireEnv(env, "X402_USDC_ASSET"), "X402_USDC_ASSET");
  const facilitator = normalizeUrl(requireEnv(env, "X402_FACILITATOR"), "X402_FACILITATOR");
  const treasury = checksumAddress(
    requireEnv(env, "ANTFLEET_X402_TREASURY"),
    "ANTFLEET_X402_TREASURY",
  );
  const priceUsdc = env["X402_REVIEW_PRICE_USDC"] ?? "0";
  if (!/^\d+(\.\d{1,6})?$/.test(priceUsdc)) {
    throw new X402ConfigError(
      "x402_price_invalid",
      "X402_REVIEW_PRICE_USDC must be a decimal USDC amount with <= 6 decimals",
    );
  }

  const repoScanPriceUsdc = env["X402_REPO_SCAN_PRICE_USDC"] ?? "2.00";
  if (!/^\d+(\.\d{1,6})?$/.test(repoScanPriceUsdc)) {
    throw new X402ConfigError(
      "x402_repo_scan_price_invalid",
      "X402_REPO_SCAN_PRICE_USDC must be a decimal USDC amount with <= 6 decimals",
    );
  }

  const expectedAsset = network === X402_MAINNET_NETWORK ? X402_MAINNET_USDC : X402_SEPOLIA_USDC;
  if (usdcAsset !== getAddress(expectedAsset)) {
    throw new X402ConfigError(
      "x402_network_asset_mismatch",
      "X402_NETWORK and X402_USDC_ASSET are not a supported Base USDC pair",
    );
  }

  const expectedFacilitator =
    network === X402_MAINNET_NETWORK ? X402_MAINNET_FACILITATOR : X402_SEPOLIA_FACILITATOR;
  if (facilitator !== expectedFacilitator) {
    throw new X402ConfigError(
      "x402_facilitator_network_mismatch",
      `X402_FACILITATOR must be ${expectedFacilitator} for ${network}`,
    );
  }

  const cdpApiKeyId = env["CDP_API_KEY_ID"] ?? null;
  const cdpApiKeySecret = env["CDP_API_KEY_SECRET"] ?? null;
  if (network === X402_MAINNET_NETWORK && (!cdpApiKeyId || !cdpApiKeySecret)) {
    throw new X402ConfigError(
      "x402_cdp_credentials_missing",
      "CDP_API_KEY_ID and CDP_API_KEY_SECRET are required for Base mainnet x402",
    );
  }
  validateTimeoutOverride(env);
  maybeProbeFacilitator(env, facilitator);

  return {
    network,
    usdcAsset,
    facilitator,
    treasury,
    priceUsdc,
    priceBaseUnits: usdcToBaseUnits(priceUsdc),
    repoScanPriceUsdc,
    repoScanPriceBaseUnits: usdcToBaseUnits(repoScanPriceUsdc),
    cdpApiKeyId,
    cdpApiKeySecret,
  };
}

export function isX402ConfigError(err: unknown): err is X402ConfigError {
  return err instanceof X402ConfigError;
}

export function isFreeX402ReviewPrice(config: Pick<X402Config, "priceBaseUnits">): boolean {
  return config.priceBaseUnits === "0";
}

function requireEnv(env: EnvMap, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new X402ConfigError(`${name.toLowerCase()}_missing`, `${name} is required`);
  }
  return value.trim();
}

function normalizeUrl(value: string, name: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      throw new X402ConfigError(`${name.toLowerCase()}_invalid`, `${name} must be https`);
    }
    return url.toString().replace(/\/$/, "");
  } catch (err) {
    if (err instanceof X402ConfigError) throw err;
    throw new X402ConfigError(`${name.toLowerCase()}_invalid`, `${name} must be a valid URL`);
  }
}

function checksumAddress(value: string, name: string): string {
  if (!isAddress(value, { strict: true })) {
    throw new X402ConfigError(
      `${name.toLowerCase()}_invalid`,
      `${name} must be EIP-55 checksummed`,
    );
  }
  return getAddress(value);
}

function usdcToBaseUnits(value: string): string {
  const [whole, frac = ""] = value.split(".");
  if (whole === undefined) throw new X402ConfigError("x402_price_invalid", "invalid price");
  const padded = (frac + "000000").slice(0, 6);
  return (BigInt(whole) * 1_000_000n + BigInt(padded || "0")).toString();
}

function validateTimeoutOverride(env: EnvMap): void {
  const raw = env["X402_MAX_TIMEOUT_SECONDS"];
  if (raw === undefined || raw.trim() === "") return;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new X402ConfigError(
      "x402_max_timeout_seconds_invalid",
      "X402_MAX_TIMEOUT_SECONDS must be a positive integer number of seconds",
    );
  }
}

function maybeProbeFacilitator(env: EnvMap, url: string): void {
  if (env !== process.env || process.env["NODE_ENV"] === "test") return;
  if (probedFacilitators.has(url)) return;
  probedFacilitators.add(url);
  void probeFacilitator(url);
}

async function probeFacilitator(url: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ac = new AbortController();
    timer = setTimeout(() => ac.abort(), 5000);
    const res = await fetch(url, { method: "HEAD", signal: ac.signal });
    if (!res.ok && res.status !== 405) {
      console.warn(`[x402] Facilitator probe returned ${res.status} for ${url}`);
    }
  } catch (err) {
    console.warn(`[x402] Facilitator probe failed for ${url}: ${err}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
