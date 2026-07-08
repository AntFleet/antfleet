import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { mintAeonContextToken } from "@/lib/x402/aeon-gate";
import {
  X402_SEPOLIA_FACILITATOR,
  X402_SEPOLIA_NETWORK,
  X402_SEPOLIA_USDC,
  type X402Config,
} from "@/lib/x402/env";
import { X402PaymentError } from "@/lib/x402/facilitator";
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
  priceUsdc: "0",
  priceBaseUnits: "0",
  repoScanPriceUsdc: "2.00",
  repoScanPriceBaseUnits: "2000000",
  cdpApiKeyId: null,
  cdpApiKeySecret: null,
};

const paidConfig: X402Config = {
  ...config,
  priceUsdc: "0.5",
  priceBaseUnits: "500000",
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
    claimReviewAuthorization: vi.fn(),
    markReviewClaimStatus: vi.fn(),
    makeOctokit: vi.fn(),
    scheduleWorker: vi.fn(),
    ...overrides,
  };
}

function request(
  body: Record<string, unknown> = { target: { pr: 1, repo: "antfleet/x402-fixture" } },
  headers: HeadersInit = {},
) {
  return new NextRequest("https://www.antfleet.dev/api/v1/review/x402", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
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
        getCommit: vi.fn(async () => ({
          data: { sha: "abc1234567890abcdef1234567890abcdef12345678" },
        })),
      },
      git: {
        getTree: vi.fn(),
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
    loadConfig: () => paidConfig,
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
    claimReviewAuthorization: vi.fn(async () => ({ claimed: true as const, claimId: "claim-1" })),
    markReviewClaimStatus: vi.fn(async () => undefined),
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
      const res = await handleX402ReviewRequest(
        request(undefined, aeonHeader()),
        deps({ loadConfig: () => paidConfig }),
      );

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

  it("enqueues a free review without payment when x402 price is zero", async () => {
    await withGate(async () => {
      const createJob = vi.fn(async () => job());
      const scheduleWorker = vi.fn();
      const res = await handleX402ReviewRequest(
        request(undefined, aeonHeader()),
        happyDeps({ createJob, scheduleWorker, loadConfig: () => config }),
      );

      expect(res.status).toBe(202);
      await expect(res.json()).resolves.toMatchObject({ jobId: "job-1", status: "queued" });
      expect(createJob).toHaveBeenCalledWith(
        expect.objectContaining({
          repoOwner: "antfleet",
          repoName: "x402-fixture",
          prNumber: 1,
          settlementStatus: "not_settled",
        }),
      );
      expect(scheduleWorker).toHaveBeenCalledWith("job-1");
    });
  });

  it("enqueues a fleet commit snapshot when aeon requests fleet_commit_review on sha", async () => {
    await withGate(async () => {
      const createJob = vi.fn(async () =>
        job({ prNumber: 0, sha: "abc1234567890abcdef1234567890abcdef12345678" }),
      );
      const scheduleWorker = vi.fn();
      const res = await handleX402ReviewRequest(
        request(
          {
            target: { repo: "antfleet/x402-fixture", sha: "abc1234" },
            sting: { fleet_commit_review: true, correlation_id: "corr-1" },
          },
          aeonHeader(),
        ),
        happyDeps({ createJob, scheduleWorker, loadConfig: () => config }),
      );

      expect(res.status).toBe(202);
      expect(createJob).toHaveBeenCalledWith(
        expect.objectContaining({
          repoOwner: "antfleet",
          repoName: "x402-fixture",
          prNumber: 0,
          sha: "abc1234567890abcdef1234567890abcdef12345678",
        }),
      );
    });
  });

  it("enqueues fleet commit review when global aeon gate is open but caller presents a valid token", async () => {
    const oldRequire = process.env["X402_REQUIRE_AEON_CONTEXT"];
    const oldSecrets = process.env["AEON_GATE_SECRETS"];
    process.env["X402_REQUIRE_AEON_CONTEXT"] = "false";
    process.env["AEON_GATE_SECRETS"] = JSON.stringify([{ kid: "k1", secret: "secret" }]);
    try {
      const createJob = vi.fn(async () =>
        job({ prNumber: 0, sha: "abc1234567890abcdef1234567890abcdef12345678" }),
      );
      const scheduleWorker = vi.fn();
      const makeOctokit = vi.fn(() => ({
        rest: {
          pulls: { get: vi.fn() },
          repos: {
            listPullRequestsAssociatedWithCommit: vi.fn(async () => ({ data: [] })),
            getCommit: vi.fn(async () => ({
              data: { sha: "abc1234567890abcdef1234567890abcdef12345678" },
            })),
          },
          git: { getTree: vi.fn() },
        },
      }));
      const res = await handleX402ReviewRequest(
        request(
          {
            target: { repo: "antfleet/x402-fixture", sha: "abc1234" },
            sting: { fleet_commit_review: true, correlation_id: "corr-1" },
          },
          aeonHeader(),
        ),
        happyDeps({ createJob, scheduleWorker, loadConfig: () => config, makeOctokit }),
      );

      expect(res.status).toBe(202);
      expect(createJob).toHaveBeenCalledWith(
        expect.objectContaining({
          repoOwner: "antfleet",
          repoName: "x402-fixture",
          prNumber: 0,
        }),
      );
    } finally {
      if (oldRequire === undefined) delete process.env["X402_REQUIRE_AEON_CONTEXT"];
      else process.env["X402_REQUIRE_AEON_CONTEXT"] = oldRequire;
      if (oldSecrets === undefined) delete process.env["AEON_GATE_SECRETS"];
      else process.env["AEON_GATE_SECRETS"] = oldSecrets;
    }
  });

  it("rejects fleet_commit_review without a valid aeon token when the global gate is open", async () => {
    const oldRequire = process.env["X402_REQUIRE_AEON_CONTEXT"];
    process.env["X402_REQUIRE_AEON_CONTEXT"] = "false";
    try {
      const res = await handleX402ReviewRequest(
        request({
          target: { repo: "antfleet/x402-fixture", sha: "abc1234" },
          sting: { fleet_commit_review: true, correlation_id: "corr-1" },
        }),
        happyDeps({ loadConfig: () => config }),
      );

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "aeon_context_required" },
      });
    } finally {
      if (oldRequire === undefined) delete process.env["X402_REQUIRE_AEON_CONTEXT"];
      else process.env["X402_REQUIRE_AEON_CONTEXT"] = oldRequire;
    }
  });

  it("still requires an open PR head for sha-only requests without fleet_commit_review", async () => {
    await withGate(async () => {
      const makeOctokit = vi.fn(() => ({
        rest: {
          pulls: { get: vi.fn() },
          repos: {
            listPullRequestsAssociatedWithCommit: vi.fn(async () => ({ data: [] })),
            getCommit: vi.fn(),
          },
          git: { getTree: vi.fn() },
        },
      }));
      const res = await handleX402ReviewRequest(
        request({ target: { repo: "antfleet/x402-fixture", sha: "abc1234" } }, aeonHeader()),
        deps({ loadConfig: () => config, makeOctokit }),
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "sha_not_in_open_pr" },
      });
    });
  });

  it("verifies payment before repo cooldown and scopes cooldown to the verified wallet", async () => {
    await withGate(async () => {
      const verifyPayment = vi.fn(async () => ({
        callerWallet: WALLET_ONE,
        payload: {},
        payloadBase64: "payload",
        validAfter: NOW,
        validBefore: new Date(NOW.getTime() + 600_000),
        resource: "https://www.antfleet.dev/api/v1/review/x402",
        facilitatorResponse: { isValid: true },
      }));
      const createJob = vi.fn();
      const findRecentRepoShaJob = vi.fn(async () =>
        job({ callerWallet: WALLET_ONE, status: "complete" }),
      );
      const res = await handleX402ReviewRequest(
        request(undefined, { ...aeonHeader(), "payment-signature": paymentSignature(WALLET_TWO) }),
        happyDeps({ verifyPayment, createJob, findRecentRepoShaJob }),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ jobId: "job-1", status: "complete" });
      expect(verifyPayment).toHaveBeenCalledTimes(1);
      expect(createJob).not.toHaveBeenCalled();
      expect(findRecentRepoShaJob).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "antfleet",
          repo: "x402-fixture",
          sha: "abc1234",
          callerWallet: WALLET_ONE,
        }),
      );
    });
  });

  it("rejects wallet quota after payment verification and exposes retry-after", async () => {
    await withGate(async () => {
      const verifyPayment = vi.fn(async () => ({
        callerWallet: WALLET_ONE,
        payload: {},
        payloadBase64: "payload",
        validAfter: NOW,
        validBefore: new Date(NOW.getTime() + 600_000),
        resource: "https://www.antfleet.dev/api/v1/review/x402",
        facilitatorResponse: { isValid: true },
      }));
      const checkWalletRateLimit = vi.fn(async () => ({
        ok: false as const,
        retryAfterSeconds: 123,
        limit: 10,
      }));
      const res = await handleX402ReviewRequest(
        request(undefined, { ...aeonHeader(), "payment-signature": paymentSignature() }),
        happyDeps({ verifyPayment, checkWalletRateLimit }),
      );

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("123");
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "rate_limited_wallet" },
        retry_after_seconds: 123,
      });
      expect(Number.isInteger(123)).toBe(true);
      expect(verifyPayment).toHaveBeenCalledTimes(1);
      expect(checkWalletRateLimit).toHaveBeenCalledWith({
        callerWallet: WALLET_ONE,
        now: NOW,
      });
    });
  });

  it("returns an existing idempotent terminal job only after payment verification", async () => {
    await withGate(async () => {
      const verifyPayment = vi.fn(async () => ({
        callerWallet: WALLET_ONE,
        payload: {},
        payloadBase64: "payload",
        validAfter: NOW,
        validBefore: new Date(NOW.getTime() + 600_000),
        resource: "https://www.antfleet.dev/api/v1/review/x402",
        facilitatorResponse: { isValid: true },
      }));
      const createJob = vi.fn();
      const scheduleWorker = vi.fn();
      const findJobByIdempotencyKey = vi.fn(async () => job({ status: "complete" }));
      const res = await handleX402ReviewRequest(
        request(undefined, { ...aeonHeader(), "payment-signature": paymentSignature() }),
        happyDeps({ verifyPayment, createJob, scheduleWorker, findJobByIdempotencyKey }),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ jobId: "job-1", status: "complete" });
      expect(verifyPayment).toHaveBeenCalledTimes(1);
      expect(createJob).not.toHaveBeenCalled();
      expect(scheduleWorker).not.toHaveBeenCalled();
    });
  });

  it("does not resolve GitHub target or read cooldown state when payment verification fails", async () => {
    await withGate(async () => {
      const verifyPayment = vi.fn(async () => {
        throw new X402PaymentError(402, "x402_verify_failed", "x402 payment verification failed");
      });
      const makeOctokit = vi.fn(() => octokit());
      const findRecentRepoShaJob = vi.fn(async () => null);
      const checkWalletRateLimit = vi.fn(async () => ({ ok: true as const }));
      const findJobByIdempotencyKey = vi.fn(async () => null);
      const res = await handleX402ReviewRequest(
        request(undefined, { ...aeonHeader(), "payment-signature": paymentSignature(WALLET_TWO) }),
        happyDeps({
          verifyPayment,
          makeOctokit,
          findRecentRepoShaJob,
          checkWalletRateLimit,
          findJobByIdempotencyKey,
        }),
      );

      expect(res.status).toBe(402);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "x402_verify_failed" },
      });
      expect(makeOctokit).not.toHaveBeenCalled();
      expect(findRecentRepoShaJob).not.toHaveBeenCalled();
      expect(checkWalletRateLimit).not.toHaveBeenCalled();
      expect(findJobByIdempotencyKey).not.toHaveBeenCalled();
      expect(verifyPayment).toHaveBeenCalledTimes(1);
    });
  });

  it("does not consume rate-limit budget for invalid aeon context", async () => {
    const checkWalletRateLimit = vi.fn(async () => ({ ok: true as const }));
    const res = await handleX402ReviewRequest(
      request(undefined, { "x-aeon-context": "invalid", "payment-signature": paymentSignature() }),
      happyDeps({ checkWalletRateLimit }),
    );

    expect(res.status).toBe(403);
    expect(checkWalletRateLimit).not.toHaveBeenCalled();
  });

  it("enqueues a valid paid request after an invalid aeon-context rejection", async () => {
    await withGate(async () => {
      const checkWalletRateLimit = vi.fn(async () => ({ ok: true as const }));
      const res = await handleX402ReviewRequest(
        request(undefined, { ...aeonHeader(), "payment-signature": paymentSignature() }),
        happyDeps({ checkWalletRateLimit }),
      );

      expect(res.status).toBe(202);
      expect(checkWalletRateLimit).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects a replayed x402 authorization with 409 and does not enqueue a second job", async () => {
    await withGate(async () => {
      const claimReviewAuthorization = vi.fn(async () => ({
        claimed: false as const,
        reason: "duplicate_authorization" as const,
      }));
      const createJob = vi.fn();
      const scheduleWorker = vi.fn();
      const checkWalletRateLimit = vi.fn(async () => ({ ok: true as const }));
      const res = await handleX402ReviewRequest(
        request(undefined, { ...aeonHeader(), "payment-signature": paymentSignature() }),
        happyDeps({ claimReviewAuthorization, createJob, scheduleWorker, checkWalletRateLimit }),
      );

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "duplicate_x402_authorization" },
      });
      expect(claimReviewAuthorization).toHaveBeenCalledTimes(1);
      // Rate-limit budget MUST NOT be consumed on a replay reject.
      expect(checkWalletRateLimit).not.toHaveBeenCalled();
      expect(createJob).not.toHaveBeenCalled();
      expect(scheduleWorker).not.toHaveBeenCalled();
    });
  });

  it("claims the authorization once, then 409s the second attempt with the same authorization", async () => {
    await withGate(async () => {
      // Same in-memory store simulates the unique-index on authorization_key.
      const claimed = new Set<string>();
      const claimReviewAuthorization = vi.fn(
        async (args: {
          authorizationKey: string;
        }): Promise<
          | {
              claimed: true;
              claimId: string;
            }
          | { claimed: false; reason: "duplicate_authorization" }
        > => {
          if (claimed.has(args.authorizationKey)) {
            return { claimed: false, reason: "duplicate_authorization" };
          }
          claimed.add(args.authorizationKey);
          return { claimed: true, claimId: "claim-1" };
        },
      );
      const createJob = vi.fn(async () => job());
      const scheduleWorker = vi.fn();

      const sig = paymentSignature();
      const first = await handleX402ReviewRequest(
        request(undefined, { ...aeonHeader(), "payment-signature": sig }),
        happyDeps({
          claimReviewAuthorization,
          createJob,
          scheduleWorker,
          // The idempotency lookup must miss on the second attempt too so we
          // exercise the claim guard rather than the idempotency short-circuit.
          findJobByIdempotencyKey: vi.fn(async () => null),
          findRecentRepoShaJob: vi.fn(async () => null),
        }),
      );
      expect(first.status).toBe(202);

      const second = await handleX402ReviewRequest(
        request(undefined, { ...aeonHeader(), "payment-signature": sig }),
        happyDeps({
          claimReviewAuthorization,
          createJob,
          scheduleWorker,
          findJobByIdempotencyKey: vi.fn(async () => null),
          findRecentRepoShaJob: vi.fn(async () => null),
        }),
      );

      expect(second.status).toBe(409);
      await expect(second.json()).resolves.toMatchObject({
        error: { code: "duplicate_x402_authorization" },
      });
      expect(createJob).toHaveBeenCalledTimes(1);
      expect(scheduleWorker).toHaveBeenCalledTimes(1);
    });
  });

  it("marks the claim rate_limited when the wallet quota fires after a successful claim", async () => {
    await withGate(async () => {
      const claimReviewAuthorization = vi.fn(async () => ({
        claimed: true as const,
        claimId: "claim-1",
      }));
      const markReviewClaimStatus = vi.fn(async () => undefined);
      const checkWalletRateLimit = vi.fn(async () => ({
        ok: false as const,
        retryAfterSeconds: 42,
        limit: 10,
      }));
      const res = await handleX402ReviewRequest(
        request(undefined, { ...aeonHeader(), "payment-signature": paymentSignature() }),
        happyDeps({ claimReviewAuthorization, markReviewClaimStatus, checkWalletRateLimit }),
      );

      expect(res.status).toBe(429);
      expect(markReviewClaimStatus).toHaveBeenCalledWith(
        expect.objectContaining({ claimId: "claim-1", status: "rate_limited" }),
      );
    });
  });

  it("marks the claim dispatch_failed when createJob throws after a successful claim", async () => {
    await withGate(async () => {
      const claimReviewAuthorization = vi.fn(async () => ({
        claimed: true as const,
        claimId: "claim-1",
      }));
      const markReviewClaimStatus = vi.fn(async () => undefined);
      const createJob = vi.fn(async () => {
        throw new Error("db down");
      });
      const res = await handleX402ReviewRequest(
        request(undefined, { ...aeonHeader(), "payment-signature": paymentSignature() }),
        happyDeps({ claimReviewAuthorization, markReviewClaimStatus, createJob }),
      );

      expect(res.status).toBe(500);
      expect(markReviewClaimStatus).toHaveBeenCalledWith(
        expect.objectContaining({ claimId: "claim-1", status: "dispatch_failed" }),
      );
    });
  });
});
