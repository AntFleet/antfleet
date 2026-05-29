import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { mintAeonContextToken } from "@/lib/x402/aeon-gate";
import {
  X402_SEPOLIA_FACILITATOR,
  X402_SEPOLIA_NETWORK,
  X402_SEPOLIA_USDC,
  type X402Config,
} from "@/lib/x402/env";
import { handleX402ReviewRequest, type X402RouteDeps } from "./route";
import type { ReviewJobRow } from "@/lib/review-job-queries";

const NOW = new Date("2026-05-29T00:00:00Z");
const WALLET_ONE = "0x0000000000000000000000000000000000000001";
const WALLET_TWO = "0x0000000000000000000000000000000000000002";

const config: X402Config = {
  network: X402_SEPOLIA_NETWORK,
  usdcAsset: X402_SEPOLIA_USDC,
  facilitator: X402_SEPOLIA_FACILITATOR,
  treasury: "0x000000000000000000000000000000000000dEaD",
  priceUsdc: "0.5",
  priceBaseUnits: "500000",
  cdpApiKeyId: null,
  cdpApiKeySecret: null,
};

function deps(overrides: Partial<X402RouteDeps> = {}): X402RouteDeps {
  return {
    now: () => NOW,
    loadConfig: () => config,
    verifyPayment: vi.fn(),
    createJob: vi.fn(),
    findJobByIdempotencyKey: vi.fn(),
    findRecentRepoShaJob: vi.fn(),
    checkWalletRateLimit: vi.fn(),
    makeOctokit: vi.fn(),
    scheduleWorker: vi.fn(),
    ...overrides,
  };
}

function request(headers: HeadersInit = {}) {
  return new NextRequest("https://www.antfleet.dev/api/v1/review/x402", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ target: { pr: 1, repo: "antfleet/x402-fixture" } }),
  });
}

function aeonHeader() {
  const token = mintAeonContextToken({
    kid: "k1",
    secret: "secret",
    sessionId: "session-1",
    timestamp: Math.floor(NOW.getTime() / 1000),
  });
  return { "x-aeon-context": token };
}

async function withGate<T>(fn: () => Promise<T>): Promise<T> {
  const oldSecrets = process.env["AEON_GATE_SECRETS"];
  process.env["AEON_GATE_SECRETS"] = JSON.stringify([{ kid: "k1", secret: "secret" }]);
  try {
    return await fn();
  } finally {
    if (oldSecrets === undefined) delete process.env["AEON_GATE_SECRETS"];
    else process.env["AEON_GATE_SECRETS"] = oldSecrets;
  }
}

function paymentSignature(wallet = WALLET_ONE) {
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

function octokit() {
  return {
    rest: {
      pulls: {
        get: vi.fn(async () => ({
          data: { state: "open", head: { sha: "abc1234" } },
        })),
      },
      repos: {
        listPullRequestsAssociatedWithCommit: vi.fn(),
      },
    },
  };
}

function job(overrides: Partial<ReviewJobRow> = {}): ReviewJobRow {
  return {
    jobId: "job-1",
    installationId: "x402",
    walletAddress: WALLET_ONE,
    repoOwner: "antfleet",
    repoName: "x402-fixture",
    prNumber: 1,
    sha: "abc1234",
    idempotencyKey: "key",
    status: "queued",
    failureMode: null,
    failureMessage: null,
    result: null,
    debitPaymentId: null,
    refundPaymentId: null,
    callerWallet: WALLET_ONE,
    paymentRail: "x402" as const,
    x402PayTo: config.treasury,
    createdAt: NOW,
    startedAt: null,
    completedAt: null,
    expiresAt: new Date("2026-05-30T00:00:00Z"),
    ...overrides,
  };
}

function happyDeps(overrides: Partial<X402RouteDeps> = {}): X402RouteDeps {
  return deps({
    verifyPayment: vi.fn(async () => ({
      callerWallet: WALLET_ONE,
      payload: {},
      payloadBase64: "payload",
      validAfter: NOW,
      validBefore: new Date(NOW.getTime() + 600_000),
      resource: "https://www.antfleet.dev/api/v1/review/x402",
      facilitatorResponse: { isValid: true },
    })),
    createJob: vi.fn(async () => job()),
    findJobByIdempotencyKey: vi.fn(async () => null),
    findRecentRepoShaJob: vi.fn(async () => null),
    checkWalletRateLimit: vi.fn(async () => ({ ok: true as const })),
    makeOctokit: vi.fn(() => octokit()),
    ...overrides,
  });
}

describe("POST /api/v1/review/x402", () => {
  it("rejects missing aeon context before payment negotiation", async () => {
    const res = await handleX402ReviewRequest(request(), deps());

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "aeon_context_required" },
    });
  });

  it("returns x402 v2 payment requirements when gate passes and payment is missing", async () => {
    await withGate(async () => {
      const res = await handleX402ReviewRequest(request(aeonHeader()), deps());

      expect(res.status).toBe(402);
      expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
      expect(res.headers.get("Access-Control-Expose-Headers")).toBe(
        "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
      );
      await expect(res.json()).resolves.toMatchObject({
        x402Version: 2,
        resource: { url: "https://www.antfleet.dev/api/v1/review/x402" },
        accepts: [{ scheme: "exact", network: "eip155:84532", amount: "500000" }],
        error: "PAYMENT-REQUIRED",
      });
    });
  });

  it("checks cooldown before payment verification", async () => {
    await withGate(async () => {
      const verifyPayment = vi.fn();
      const createJob = vi.fn();
      const findRecentRepoShaJob = vi.fn(async () =>
        job({ callerWallet: WALLET_ONE, status: "complete" }),
      );
      const res = await handleX402ReviewRequest(
        request({ ...aeonHeader(), "payment-signature": paymentSignature(WALLET_TWO) }),
        happyDeps({ verifyPayment, createJob, findRecentRepoShaJob }),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ jobId: "job-1", status: "complete" });
      expect(verifyPayment).not.toHaveBeenCalled();
      expect(createJob).not.toHaveBeenCalled();
      expect(findRecentRepoShaJob).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "antfleet", repo: "x402-fixture", sha: "abc1234" }),
      );
    });
  });

  it("rejects wallet quota before payment verification and exposes retry-after", async () => {
    await withGate(async () => {
      const verifyPayment = vi.fn();
      const checkWalletRateLimit = vi.fn(async () => ({
        ok: false as const,
        retryAfterSeconds: 123,
        limit: 10,
      }));
      const res = await handleX402ReviewRequest(
        request({ ...aeonHeader(), "payment-signature": paymentSignature() }),
        happyDeps({ verifyPayment, checkWalletRateLimit }),
      );

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("123");
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "rate_limited_wallet" },
        retry_after_seconds: 123,
      });
      expect(Number.isInteger(123)).toBe(true);
      expect(verifyPayment).not.toHaveBeenCalled();
    });
  });

  it("returns an existing idempotent terminal job without payment verification", async () => {
    await withGate(async () => {
      const verifyPayment = vi.fn();
      const createJob = vi.fn();
      const scheduleWorker = vi.fn();
      const findJobByIdempotencyKey = vi.fn(async () => job({ status: "complete" }));
      const res = await handleX402ReviewRequest(
        request({ ...aeonHeader(), "payment-signature": paymentSignature() }),
        happyDeps({ verifyPayment, createJob, scheduleWorker, findJobByIdempotencyKey }),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ jobId: "job-1", status: "complete" });
      expect(verifyPayment).not.toHaveBeenCalled();
      expect(createJob).not.toHaveBeenCalled();
      expect(scheduleWorker).not.toHaveBeenCalled();
    });
  });

  it("does not consume rate-limit budget for invalid aeon context", async () => {
    const checkWalletRateLimit = vi.fn(async () => ({ ok: true as const }));
    const res = await handleX402ReviewRequest(
      request({ "x-aeon-context": "invalid", "payment-signature": paymentSignature() }),
      happyDeps({ checkWalletRateLimit }),
    );

    expect(res.status).toBe(403);
    expect(checkWalletRateLimit).not.toHaveBeenCalled();
  });

  it("enqueues a valid paid request after an invalid aeon-context rejection", async () => {
    await withGate(async () => {
      const checkWalletRateLimit = vi.fn(async () => ({ ok: true as const }));
      const res = await handleX402ReviewRequest(
        request({ ...aeonHeader(), "payment-signature": paymentSignature() }),
        happyDeps({ checkWalletRateLimit }),
      );

      expect(res.status).toBe(202);
      expect(checkWalletRateLimit).toHaveBeenCalledTimes(1);
    });
  });
});
