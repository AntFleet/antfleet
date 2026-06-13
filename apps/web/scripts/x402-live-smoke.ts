import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { NextRequest } from "next/server";
import { Octokit } from "@octokit/rest";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import {
  createPublicClient,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  X402PaymentError,
  verifyPayment,
} from "@/lib/x402/facilitator";
import {
  loadX402Config,
  X402_MAINNET_NETWORK,
  X402_MAINNET_USDC,
  X402_SEPOLIA_FACILITATOR,
  X402_SEPOLIA_NETWORK,
  X402_SEPOLIA_USDC,
  type X402Config,
} from "@/lib/x402/env";
import type { X402RouteDeps } from "@/app/api/v1/review/x402/route";
import type { ReviewJobRow } from "@/lib/review-job-queries";

loadDotenv({ path: ".env.local" });

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const DEFAULT_TEST_PAY_TO = "0x000000000000000000000000000000000000dEaD" as const;
const DEFAULT_RESOURCE = "https://www.antfleet.dev/api/v1/review/x402";

type Mode =
  | "balance"
  | "verify"
  | "settle"
  | "route-smoke"
  | "traffic"
  | "worker-e2e"
  | "mainnet-dry";

type Cli = {
  mode: Mode;
  amountUsdc: string;
  payTo?: Address;
  resource: string;
  repo: string;
  pr: number;
  useRepoTestWallet: boolean;
  allowMainnetSettle: boolean;
  trafficCount: number;
  skipOnMissingCreds: boolean;
};

type LiveContext = {
  config: X402Config;
  account: ReturnType<typeof privateKeyToAccount>;
  publicClient: PublicClient;
  httpClient: x402HTTPClient;
};

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const config = configFor(cli);

  if (cli.mode === "mainnet-dry") {
    await runMainnetDry(config);
    return;
  }

  if (
    config.network === X402_MAINNET_NETWORK &&
    (cli.mode === "settle" || cli.mode === "worker-e2e") &&
    !cli.allowMainnetSettle
  ) {
    throw new Error(
      "mainnet settlement is blocked; pass --allow-mainnet-settle only for launch rehearsal",
    );
  }

  if (cli.mode === "traffic") {
    await runTraffic(cli, config);
    return;
  }

  const ctx = makeLiveContext(cli, config);
  if (cli.mode === "balance") {
    await printBalances(ctx);
    return;
  }

  if (cli.mode === "route-smoke") {
    await runRouteSmoke(cli, ctx);
    return;
  }
  if (cli.mode === "worker-e2e") {
    await runWorkerE2E(cli, ctx);
    return;
  }

  const paymentRequired = buildPaymentRequiredForSmoke(ctx.config, cli.resource);
  const paymentPayload = await ctx.httpClient.createPaymentPayload(paymentRequired as never);
  const verifyBody = await callFacilitator(
    ctx.config,
    "verify",
    paymentPayload,
    paymentRequired.accepts[0],
  );
  if (!isVerifyValid(verifyBody.body)) {
    console.log(
      JSON.stringify(
        {
          stage: "verify",
          ok: false,
          httpStatus: verifyBody.status,
          body: summarizeFacilitatorBody(verifyBody.body),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  if (cli.mode === "verify") {
    console.log(
      JSON.stringify(
        {
          stage: "verify",
          ok: true,
          network: ctx.config.network,
          payer: ctx.account.address,
          payTo: ctx.config.treasury,
          amountUsdc: ctx.config.priceUsdc,
          facilitator: ctx.config.facilitator,
          response: summarizeFacilitatorBody(verifyBody.body),
        },
        null,
        2,
      ),
    );
    return;
  }

  const before = await readBalances(ctx);
  const settleBody = await callFacilitator(
    ctx.config,
    "settle",
    paymentPayload,
    paymentRequired.accepts[0],
  );
  const txHash = extractSettlementTx(settleBody.body);
  if (txHash !== null) {
    await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
  }
  const after = await readBalances(ctx);

  console.log(
    JSON.stringify(
      {
        stage: "settle",
        ok: isSettlementSuccessful(settleBody.body),
        network: ctx.config.network,
        payer: ctx.account.address,
        payTo: ctx.config.treasury,
        amountUsdc: ctx.config.priceUsdc,
        settlementTx: txHash,
        balances: {
          payerBeforeUsdc: before.payerUsdc,
          payerAfterUsdc: after.payerUsdc,
          payToBeforeUsdc: before.payToUsdc,
          payToAfterUsdc: after.payToUsdc,
          payerEth: after.payerEth,
        },
        response: summarizeFacilitatorBody(settleBody.body),
      },
      null,
      2,
    ),
  );
}

function parseCli(args: string[]): Cli {
  const cli: Cli = {
    mode: "verify",
    amountUsdc:
      process.env["X402_SMOKE_AMOUNT_USDC"] ?? process.env["X402_REVIEW_PRICE_USDC"] ?? "0.01",
    resource: process.env["X402_SMOKE_RESOURCE"] ?? DEFAULT_RESOURCE,
    repo: process.env["X402_SMOKE_REPO"] ?? "antfleet/x402-fixture",
    pr: Number(process.env["X402_SMOKE_PR"] ?? "1"),
    useRepoTestWallet: process.env["X402_SMOKE_PRIVATE_KEY"] === undefined,
    allowMainnetSettle: false,
    trafficCount: 20,
    skipOnMissingCreds: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const readValue = () => {
      const value = args[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--mode") cli.mode = parseMode(readValue());
    else if (arg === "--amount-usdc") cli.amountUsdc = readValue();
    else if (arg === "--pay-to") cli.payTo = getAddress(readValue());
    else if (arg === "--resource") cli.resource = readValue();
    else if (arg === "--repo") cli.repo = readValue();
    else if (arg === "--pr") cli.pr = Number(readValue());
    else if (arg === "--traffic-count") cli.trafficCount = Number(readValue());
    else if (arg === "--private-key-env") cli.useRepoTestWallet = false;
    else if (arg === "--repo-test-wallet") cli.useRepoTestWallet = true;
    else if (arg === "--allow-mainnet-settle") cli.allowMainnetSettle = true;
    else if (arg === "--skip-on-missing-creds") cli.skipOnMissingCreds = true;
    else if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!/^\d+(\.\d{1,6})?$/.test(cli.amountUsdc)) {
    throw new Error("--amount-usdc must have no more than 6 decimals");
  }
  if (!Number.isInteger(cli.pr) || cli.pr <= 0) throw new Error("--pr must be a positive integer");
  if (!Number.isInteger(cli.trafficCount) || cli.trafficCount <= 0) {
    throw new Error("--traffic-count must be a positive integer");
  }
  if (cli.skipOnMissingCreds && process.env["X402_SMOKE_PRIVATE_KEY"] === undefined) {
    console.log("Skipping x402 live smoke: X402_SMOKE_PRIVATE_KEY is not set.");
    process.exit(0);
  }
  return cli;
}

function parseMode(value: string): Mode {
  if (
    value === "balance" ||
    value === "verify" ||
    value === "settle" ||
    value === "route-smoke" ||
    value === "traffic" ||
    value === "worker-e2e" ||
    value === "mainnet-dry"
  ) {
    return value;
  }
  throw new Error(`unsupported mode: ${value}`);
}

function printHelp() {
  console.log(`Usage: pnpm exec tsx scripts/x402-live-smoke.ts --mode <mode>

Modes:
  balance       Read ETH/USDC balances only.
  verify        Create a payment payload and call facilitator /verify only.
  settle        Call /verify then /settle. Mainnet is blocked without --allow-mainnet-settle.
  route-smoke   Exercise the app route with live x402 verify and mocked DB/GitHub dependencies.
  traffic       Run local non-spending route traffic checks with mocked dependencies.
  worker-e2e    Create a real DB x402 job, run the worker, and settle on successful review.
  mainnet-dry   Validate Base mainnet config/facilitator supported endpoint without signing or spending.

Private key:
  Uses X402_SMOKE_PRIVATE_KEY when set. Otherwise --repo-test-wallet reads the repo test wallet.
  --skip-on-missing-creds exits 0 when X402_SMOKE_PRIVATE_KEY is missing.
`);
}

function configFor(cli: Cli): X402Config {
  const envConfig = tryLoadEnvConfig();
  const network = envConfig?.network ?? X402_SEPOLIA_NETWORK;
  const usdcAsset =
    envConfig?.usdcAsset ??
    (network === X402_MAINNET_NETWORK ? X402_MAINNET_USDC : X402_SEPOLIA_USDC);
  const facilitator =
    envConfig?.facilitator ??
    (network === X402_MAINNET_NETWORK
      ? "https://api.cdp.coinbase.com/platform/v2/x402"
      : X402_SEPOLIA_FACILITATOR);
  const treasury = cli.payTo ?? envConfig?.treasury ?? DEFAULT_TEST_PAY_TO;

  return {
    network,
    usdcAsset,
    facilitator,
    treasury,
    priceUsdc: cli.amountUsdc,
    priceBaseUnits: usdcToBaseUnits(cli.amountUsdc),
    repoScanPriceUsdc: cli.amountUsdc,
    repoScanPriceBaseUnits: usdcToBaseUnits(cli.amountUsdc),
    cdpApiKeyId: envConfig?.cdpApiKeyId ?? process.env["CDP_API_KEY_ID"] ?? null,
    cdpApiKeySecret: envConfig?.cdpApiKeySecret ?? process.env["CDP_API_KEY_SECRET"] ?? null,
  };
}

function tryLoadEnvConfig(): X402Config | null {
  try {
    return loadX402Config();
  } catch {
    return null;
  }
}

function makeLiveContext(cli: Cli, config: X402Config): LiveContext {
  const account = privateKeyToAccount(loadPrivateKey(cli));
  const chain = config.network === X402_MAINNET_NETWORK ? base : baseSepolia;
  const rpcUrl =
    config.network === X402_MAINNET_NETWORK
      ? (process.env["BASE_MAINNET_RPC_URL"] ?? "https://mainnet.base.org")
      : (process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org");
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
  const coreClient = new x402Client();
  registerExactEvmScheme(coreClient, {
    signer: toClientEvmSigner(account, publicClient),
    networks: [config.network],
    schemeOptions: { [chain.id]: { rpcUrl } },
  });
  return { config, account, publicClient, httpClient: new x402HTTPClient(coreClient) };
}

function loadPrivateKey(cli: Cli): Hex {
  if (!cli.useRepoTestWallet) {
    const key = process.env["X402_SMOKE_PRIVATE_KEY"];
    if (key === undefined || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error("X402_SMOKE_PRIVATE_KEY must be set to a 32-byte hex private key");
    }
    return key as Hex;
  }

  const source = readFileSync(
    join(process.cwd(), "app/api/v1/installations/eip191-roundtrip.test.ts"),
    "utf8",
  );
  const key = [...source.matchAll(/"(0x[0-9a-fA-F]{64})"/g)][0]?.[1];
  if (key === undefined) throw new Error("repo test wallet private key not found");
  return key as Hex;
}

function buildPaymentRequiredForSmoke(config: X402Config, resource: string) {
  return {
    x402Version: 2,
    resource: {
      url: resource,
      description: "AntFleet x402 live smoke",
      mimeType: "application/json",
      serviceName: "AntFleet PR Review",
      tags: ["pr-review", "antfleet", "smoke-test"],
    },
    accepts: [
      {
        scheme: "exact",
        network: config.network,
        asset: config.usdcAsset,
        amount: config.priceBaseUnits,
        payTo: config.treasury,
        maxTimeoutSeconds: 600,
        extra:
          config.network === X402_MAINNET_NETWORK
            ? { name: "USD Coin", version: "2" }
            : { name: "USDC", version: "2" },
      },
    ],
    error: "PAYMENT-REQUIRED",
  } as const;
}

async function runWorkerE2E(cli: Cli, ctx: LiveContext) {
  applyX402Env(ctx.config);
  const target = await resolvePrTarget(cli);
  const paymentRequired = buildPaymentRequiredForSmoke(ctx.config, cli.resource);
  const paymentPayload = await ctx.httpClient.createPaymentPayload(paymentRequired as never);
  const paymentSignature =
    ctx.httpClient.encodePaymentSignatureHeader(paymentPayload)["PAYMENT-SIGNATURE"];
  if (paymentSignature === undefined) throw new Error("payment signature was not created");
  const payment = await verifyPayment({
    paymentSignature,
    config: ctx.config,
    resource: cli.resource,
    now: new Date(),
  });
  const { db } = await import("@/db");
  const { createX402ReviewJob, getReviewJob } = await import("@/lib/review-job-queries");
  const { processReviewJob } = await import("@/lib/review-job-worker");
  const { makeAuthorizationState } = await import("@/lib/x402/facilitator");
  const idempotencyKey = `smoke:${Date.now()}:${ctx.account.address.toLowerCase()}:${target.owner}/${target.repo}:${target.prNumber}:${target.sha}`;
  const before = await readBalances(ctx);
  const job = await createX402ReviewJob(db, {
    callerWallet: payment.callerWallet,
    repoOwner: target.owner,
    repoName: target.repo,
    prNumber: target.prNumber,
    sha: target.sha,
    idempotencyKey,
    x402PayTo: ctx.config.treasury,
    authorizationState: makeAuthorizationState(payment),
  });
  const outcome = await processReviewJob(job.jobId);
  const saved = await getReviewJob(db, job.jobId);
  const after = await readBalances(ctx);
  console.log(
    JSON.stringify(
      {
        stage: "worker-e2e",
        jobId: job.jobId,
        target,
        outcome,
        finalStatus: saved?.status ?? null,
        settlementStatus: saved?.x402SettlementStatus ?? null,
        settlementTx: extractSettlementTx(saved?.x402SettlementResponse),
        resultHasReceiptUrl:
          typeof saved?.result === "object" &&
          saved.result !== null &&
          typeof (saved.result as Record<string, unknown>)["receipt_url"] === "string",
        balances: {
          payerBeforeUsdc: before.payerUsdc,
          payerAfterUsdc: after.payerUsdc,
          payToBeforeUsdc: before.payToUsdc,
          payToAfterUsdc: after.payToUsdc,
        },
      },
      null,
      2,
    ),
  );
}

async function resolvePrTarget(cli: Cli): Promise<{
  owner: string;
  repo: string;
  prNumber: number;
  sha: string;
}> {
  const [owner, repo] = cli.repo.split("/");
  if (owner === undefined || repo === undefined) throw new Error("--repo must be owner/name");
  const octokit = new Octokit({
    auth: process.env["GITHUB_PUBLIC_TOKEN"] ?? process.env["GITHUB_TOKEN"] ?? undefined,
  });
  const pr = await octokit.rest.pulls.get({ owner, repo, pull_number: cli.pr });
  if (pr.data.state !== "open") throw new Error(`PR #${cli.pr} is ${pr.data.state}; expected open`);
  return { owner, repo, prNumber: cli.pr, sha: pr.data.head.sha };
}

function applyX402Env(config: X402Config) {
  process.env["X402_NETWORK"] = config.network;
  process.env["X402_USDC_ASSET"] = config.usdcAsset;
  process.env["X402_FACILITATOR"] = config.facilitator;
  process.env["ANTFLEET_X402_TREASURY"] = config.treasury;
  process.env["X402_REVIEW_PRICE_USDC"] = config.priceUsdc;
}

async function callFacilitator(
  config: X402Config,
  path: "verify" | "settle",
  paymentPayload: unknown,
  paymentRequirements: unknown,
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.cdpApiKeyId !== null) headers["x-cdp-api-key-id"] = config.cdpApiKeyId;
  if (config.cdpApiKeySecret !== null) headers["x-cdp-api-key-secret"] = config.cdpApiKeySecret;
  const resp = await fetch(`${config.facilitator}/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
  });
  return { status: resp.status, body: await readJson(resp) };
}

async function printBalances(ctx: LiveContext) {
  const balances = await readBalances(ctx);
  console.log(
    JSON.stringify(
      {
        stage: "balance",
        network: ctx.config.network,
        payer: ctx.account.address,
        payTo: ctx.config.treasury,
        balances,
      },
      null,
      2,
    ),
  );
}

async function readBalances(ctx: LiveContext) {
  const usdc = getAddress(ctx.config.usdcAsset);
  const [payerEthRaw, payerUsdcRaw, payToUsdcRaw, payerCode] = await Promise.all([
    ctx.publicClient.getBalance({ address: ctx.account.address }),
    ctx.publicClient.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [ctx.account.address],
    }),
    ctx.config.treasury === ZERO_ADDRESS
      ? Promise.resolve(0n)
      : ctx.publicClient.readContract({
          address: usdc,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [getAddress(ctx.config.treasury)],
        }),
    ctx.publicClient.getCode({ address: ctx.account.address }),
  ]);
  return {
    payerEth: formatEther(payerEthRaw),
    payerUsdc: formatUnits(payerUsdcRaw, 6),
    payToUsdc: formatUnits(payToUsdcRaw, 6),
    payerCodeBytes: payerCode ? (payerCode.length - 2) / 2 : 0,
  };
}

async function runRouteSmoke(cli: Cli, ctx: LiveContext) {
  const oldGate = process.env["X402_REQUIRE_AEON_CONTEXT"];
  process.env["X402_REQUIRE_AEON_CONTEXT"] = "false";
  try {
    const { handleX402ReviewRequest } = await import("@/app/api/v1/review/x402/route");
    const paymentRequired = buildPaymentRequiredForSmoke(ctx.config, cli.resource);
    const paymentPayload = await ctx.httpClient.createPaymentPayload(paymentRequired as never);
    const headers = ctx.httpClient.encodePaymentSignatureHeader(paymentPayload);
    const req = new NextRequest(cli.resource, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": headers["PAYMENT-SIGNATURE"]!,
      },
      body: JSON.stringify({ target: { repo: cli.repo, pr: cli.pr } }),
    });
    const res = await handleX402ReviewRequest(req, routeDeps(ctx.config, verifyPayment));
    console.log(
      JSON.stringify(
        {
          stage: "route-smoke",
          status: res.status,
          exposeHeaders: res.headers.get("Access-Control-Expose-Headers"),
          body: await res.json(),
        },
        null,
        2,
      ),
    );
  } finally {
    if (oldGate === undefined) delete process.env["X402_REQUIRE_AEON_CONTEXT"];
    else process.env["X402_REQUIRE_AEON_CONTEXT"] = oldGate;
  }
}

async function runTraffic(cli: Cli, config: X402Config) {
  const oldGate = process.env["X402_REQUIRE_AEON_CONTEXT"];
  process.env["X402_REQUIRE_AEON_CONTEXT"] = "false";
  try {
    const { handleX402ReviewRequest } = await import("@/app/api/v1/review/x402/route");
    const deps = routeDeps(config, async () => {
      throw new X402PaymentError(402, "x402_verify_failed", "x402 payment verification failed");
    });
    const statuses = new Map<string, number>();
    for (let i = 0; i < cli.trafficCount; i++) {
      const req =
        i % 2 === 0
          ? new NextRequest(cli.resource, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ target: { repo: cli.repo, pr: cli.pr } }),
            })
          : new NextRequest(cli.resource, {
              method: "POST",
              headers: { "content-type": "application/json", "payment-signature": "invalid" },
              body: JSON.stringify({ target: { repo: cli.repo, pr: cli.pr } }),
            });
      const res = await handleX402ReviewRequest(req, deps);
      const key = `${res.status}:${i % 2 === 0 ? "missing-payment" : "invalid-payment"}`;
      statuses.set(key, (statuses.get(key) ?? 0) + 1);
      await res.text();
    }
    console.log(
      JSON.stringify(
        {
          stage: "traffic",
          requests: cli.trafficCount,
          nonSpending: true,
          exposeHeaders: `${PAYMENT_REQUIRED_HEADER}, ${PAYMENT_RESPONSE_HEADER}`,
          statuses: Object.fromEntries(statuses),
        },
        null,
        2,
      ),
    );
  } finally {
    if (oldGate === undefined) delete process.env["X402_REQUIRE_AEON_CONTEXT"];
    else process.env["X402_REQUIRE_AEON_CONTEXT"] = oldGate;
  }
}

const smokeNow = () => new Date();

function routeDeps(config: X402Config, verify: X402RouteDeps["verifyPayment"]): X402RouteDeps {
  return {
    now: smokeNow,
    loadConfig: () => config,
    verifyPayment: verify,
    createJob: async (args) => fakeJob(args),
    findJobByIdempotencyKey: async () => null,
    findRecentRepoShaJob: async () => null,
    checkWalletRateLimit: async () => ({ ok: true, limit: 100 }),
    claimReviewAuthorization: async () => ({ claimed: true, claimId: "smoke-claim" }),
    markReviewClaimStatus: async () => undefined,
    makeOctokit: () => ({
      rest: {
        pulls: {
          get: async () => ({
            data: { state: "open", head: { sha: "abcdef1234567890abcdef1234567890abcdef12" } },
          }),
        },
        repos: {
          listPullRequestsAssociatedWithCommit: async () => ({ data: [] }),
        },
      },
    }),
    scheduleWorker: () => undefined,
  };
}

function fakeJob(args: Parameters<X402RouteDeps["createJob"]>[0]): ReviewJobRow {
  const now = new Date();
  const authorizationState = readSmokeAuthorizationState(args.authorizationState);
  return {
    jobId: "route-smoke-job",
    installationId: "x402",
    walletAddress: args.callerWallet,
    repoOwner: args.repoOwner,
    repoName: args.repoName,
    prNumber: args.prNumber,
    sha: args.sha,
    idempotencyKey: args.idempotencyKey,
    status: "queued",
    failureMode: null,
    failureMessage: null,
    result: null,
    debitPaymentId: null,
    refundPaymentId: null,
    callerWallet: args.callerWallet,
    paymentRail: "x402",
    x402PayTo: args.x402PayTo,
    x402PaymentPayload: args.authorizationState,
    x402ValidAfter: new Date(authorizationState.validAfter),
    x402ValidBefore: new Date(authorizationState.validBefore),
    x402ReviewId: null,
    x402SettlementStatus: "pending",
    x402SettlementResponse: null,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
  };
}

function readSmokeAuthorizationState(value: unknown): { validAfter: string; validBefore: string } {
  if (typeof value !== "object" || value === null) throw new Error("authorization state missing");
  const record = value as Record<string, unknown>;
  if (typeof record["validAfter"] !== "string" || typeof record["validBefore"] !== "string") {
    throw new Error("authorization state window missing");
  }
  return { validAfter: record["validAfter"], validBefore: record["validBefore"] };
}

async function runMainnetDry(config: X402Config) {
  const mainnetConfig: X402Config = {
    ...config,
    network: X402_MAINNET_NETWORK,
    usdcAsset: X402_MAINNET_USDC,
    facilitator: "https://api.cdp.coinbase.com/platform/v2/x402",
  };
  const headers: Record<string, string> = {};
  if (mainnetConfig.cdpApiKeyId !== null) headers["x-cdp-api-key-id"] = mainnetConfig.cdpApiKeyId;
  if (mainnetConfig.cdpApiKeySecret !== null)
    headers["x-cdp-api-key-secret"] = mainnetConfig.cdpApiKeySecret;
  const resp = await fetch(`${mainnetConfig.facilitator}/supported`, { headers });
  console.log(
    JSON.stringify(
      {
        stage: "mainnet-dry",
        nonSpending: true,
        network: mainnetConfig.network,
        facilitator: mainnetConfig.facilitator,
        httpStatus: resp.status,
        ok: resp.ok,
        body: summarizeFacilitatorBody(await readJson(resp)),
      },
      null,
      2,
    ),
  );
}

async function readJson(resp: Response): Promise<unknown> {
  const text = await resp.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

function summarizeFacilitatorBody(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return {
    isValid: record["isValid"] ?? record["valid"] ?? record["success"],
    success: record["success"],
    payer: record["payer"] ?? record["from"] ?? record["signer"],
    network: record["network"],
    transaction: record["transaction"] ?? record["txHash"],
    error: record["error"] ?? record["errorReason"] ?? record["code"],
    message: record["message"] ?? record["errorMessage"],
  };
}

function isVerifyValid(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    ((value as Record<string, unknown>)["isValid"] === true ||
      (value as Record<string, unknown>)["valid"] === true ||
      (value as Record<string, unknown>)["success"] === true)
  );
}

function isSettlementSuccessful(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)["success"] === true
  );
}

function extractSettlementTx(value: unknown): Hex | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const tx = record["transaction"] ?? record["txHash"];
  return typeof tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(tx) ? (tx as Hex) : null;
}

function usdcToBaseUnits(value: string): string {
  const [whole, frac = ""] = value.split(".");
  return (BigInt(whole ?? "0") * 1_000_000n + BigInt((frac + "000000").slice(0, 6))).toString();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
