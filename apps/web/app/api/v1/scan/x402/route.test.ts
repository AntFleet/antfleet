import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import {
  X402_SEPOLIA_FACILITATOR,
  X402_SEPOLIA_NETWORK,
  X402_SEPOLIA_USDC,
  type X402Config,
} from "@/lib/x402/env";
import { handleX402ScanRequest, type X402ScanRouteDeps } from "./route";
import type { ScanResult } from "@/lib/repo-scanner";

const NOW = new Date("2026-06-02T00:00:00Z");
const WALLET = "0x0000000000000000000000000000000000000001";
const HEAD_SHA = "abc1234abc1234abc1234abc1234abc1234abc12";

const config: X402Config = {
  network: X402_SEPOLIA_NETWORK,
  usdcAsset: X402_SEPOLIA_USDC,
  facilitator: X402_SEPOLIA_FACILITATOR,
  treasury: "0x000000000000000000000000000000000000dEaD",
  priceUsdc: "0.5",
  priceBaseUnits: "500000",
  repoScanPriceUsdc: "2.00",
  repoScanPriceBaseUnits: "2000000",
  cdpApiKeyId: null,
  cdpApiKeySecret: null,
};

function request(headers: HeadersInit = {}) {
  return new NextRequest("https://www.antfleet.dev/api/v1/scan/x402", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ target: { repo: "antfleet/scan-fixture" } }),
  });
}

function paymentSignature(wallet = WALLET) {
  return Buffer.from(
    JSON.stringify({
      authorization: {
        from: wallet,
        validAfter: Math.floor(NOW.getTime() / 1000),
        validBefore: Math.floor(NOW.getTime() / 1000) + 600,
      },
    }),
  ).toString("base64");
}

function octokit(opts: { private?: boolean } = {}) {
  return {
    rest: {
      repos: {
        get: vi.fn(async () => ({
          data: { private: opts.private ?? false, default_branch: "main" },
        })),
      },
    },
  } as unknown as ReturnType<X402ScanRouteDeps["makeOctokit"]>;
}

function scanResult(over: Partial<ScanResult> = {}): ScanResult {
  return {
    headSha: HEAD_SHA,
    totalFiles: 12,
    chunkCount: 3,
    skippedChunks: 0,
    findings: [],
    degraded: false,
    ...over,
  };
}

function deps(overrides: Partial<X402ScanRouteDeps> = {}): X402ScanRouteDeps {
  return {
    now: () => NOW,
    loadConfig: () => config,
    verifyPayment: vi.fn(),
    settlePayment: vi.fn(),
    checkWalletRateLimit: vi.fn(),
    makeOctokit: vi.fn(() => octokit()),
    scanRepo: vi.fn(),
    ...overrides,
  };
}

function happyDeps(overrides: Partial<X402ScanRouteDeps> = {}): X402ScanRouteDeps {
  return deps({
    verifyPayment: vi.fn(async () => ({
      callerWallet: WALLET,
      payload: {},
      payloadBase64: "payload",
      validAfter: NOW,
      validBefore: new Date(NOW.getTime() + 600_000),
      resource: "https://www.antfleet.dev/api/v1/scan/x402",
      facilitatorResponse: { isValid: true },
    })),
    settlePayment: vi.fn(async () => ({
      settled: true,
      paymentResponseHeader: null,
      response: {},
    })),
    checkWalletRateLimit: vi.fn(async () => ({ ok: true as const })),
    scanRepo: vi.fn(async () => scanResult()),
    ...overrides,
  });
}

describe("POST /api/v1/scan/x402", () => {
  it("returns x402 v2 payment requirements when payment is missing", async () => {
    const res = await handleX402ScanRequest(request(), deps());

    expect(res.status).toBe(402);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    await expect(res.json()).resolves.toMatchObject({
      x402Version: 2,
      resource: { url: "https://www.antfleet.dev/api/v1/scan/x402" },
      accepts: [{ scheme: "exact", network: "eip155:84532", amount: "2000000" }],
      error: "PAYMENT-REQUIRED",
    });
  });

  it("rejects a private repo before payment verification", async () => {
    const verifyPayment = vi.fn();
    const res = await handleX402ScanRequest(
      request({ "payment-signature": paymentSignature() }),
      happyDeps({ verifyPayment, makeOctokit: vi.fn(() => octokit({ private: true })) }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "private_repo_not_supported" },
    });
    expect(verifyPayment).not.toHaveBeenCalled();
  });

  it("rejects when the wallet quota is exhausted and exposes retry-after", async () => {
    const verifyPayment = vi.fn();
    const res = await handleX402ScanRequest(
      request({ "payment-signature": paymentSignature() }),
      happyDeps({
        verifyPayment,
        checkWalletRateLimit: vi.fn(async () => ({
          ok: false as const,
          retryAfterSeconds: 321,
          limit: 10,
        })),
      }),
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("321");
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "rate_limited_wallet" },
      retry_after_seconds: 321,
    });
    expect(verifyPayment).not.toHaveBeenCalled();
  });

  it("runs the scan and settles on a verified payment", async () => {
    const settlePayment = vi.fn(async () => ({
      settled: true,
      paymentResponseHeader: null,
      response: {},
    }));
    const scan = vi.fn(async () =>
      scanResult({ chunkCount: 4, totalFiles: 21, findings: [], headSha: HEAD_SHA }),
    );
    const res = await handleX402ScanRequest(
      request({ "payment-signature": paymentSignature() }),
      happyDeps({ settlePayment, scanRepo: scan }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: "complete",
      repo: "antfleet/scan-fixture",
      headSha: HEAD_SHA,
      chunkCount: 4,
      totalFiles: 21,
      agreedCount: 0,
      costUsdc: "2.00",
    });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(settlePayment).toHaveBeenCalledTimes(1);
  });

  it("verifies and settles with the scan-price requirements (amount 2000000)", async () => {
    const verifyPayment = vi.fn(async () => ({
      callerWallet: WALLET,
      payload: {},
      payloadBase64: "payload",
      validAfter: NOW,
      validBefore: new Date(NOW.getTime() + 600_000),
      resource: "https://www.antfleet.dev/api/v1/scan/x402",
      facilitatorResponse: { isValid: true },
    }));
    const settlePayment = vi.fn(async () => ({
      settled: true,
      paymentResponseHeader: null,
      response: {},
    }));
    const res = await handleX402ScanRequest(
      request({ "payment-signature": paymentSignature() }),
      happyDeps({ verifyPayment, settlePayment }),
    );

    expect(res.status).toBe(200);
    const expectedReq = expect.objectContaining({ amount: "2000000" });
    expect(verifyPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentRequirements: expectedReq }),
    );
    expect(settlePayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentRequirements: expectedReq }),
    );
  });

  it("does not settle when the repo has no reviewable files", async () => {
    const settlePayment = vi.fn();
    const res = await handleX402ScanRequest(
      request({ "payment-signature": paymentSignature() }),
      happyDeps({
        settlePayment,
        scanRepo: vi.fn(async () => scanResult({ chunkCount: 0, totalFiles: 0, findings: [] })),
      }),
    );

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "no_reviewable_files" },
    });
    expect(settlePayment).not.toHaveBeenCalled();
  });

  it("does not settle when the scan throws", async () => {
    const settlePayment = vi.fn();
    const res = await handleX402ScanRequest(
      request({ "payment-signature": paymentSignature() }),
      happyDeps({
        settlePayment,
        scanRepo: vi.fn(async () => {
          throw new Error("provider exploded");
        }),
      }),
    );

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "scan_failed" } });
    expect(settlePayment).not.toHaveBeenCalled();
  });
});
