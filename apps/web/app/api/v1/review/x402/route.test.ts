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

const NOW = new Date("2026-05-29T00:00:00Z");

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

describe("POST /api/v1/review/x402", () => {
  it("rejects missing aeon context before payment negotiation", async () => {
    const res = await handleX402ReviewRequest(request(), deps());

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "aeon_context_required" },
    });
  });

  it("returns x402 v2 payment requirements when gate passes and payment is missing", async () => {
    const token = mintAeonContextToken({
      kid: "k1",
      secret: "secret",
      sessionId: "session-1",
      timestamp: Math.floor(NOW.getTime() / 1000),
    });
    const oldSecrets = process.env["AEON_GATE_SECRETS"];
    process.env["AEON_GATE_SECRETS"] = JSON.stringify([{ kid: "k1", secret: "secret" }]);
    try {
      const res = await handleX402ReviewRequest(request({ "x-aeon-context": token }), deps());

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
    } finally {
      if (oldSecrets === undefined) delete process.env["AEON_GATE_SECRETS"];
      else process.env["AEON_GATE_SECRETS"] = oldSecrets;
    }
  });
});
