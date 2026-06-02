import { describe, expect, it, vi } from "vitest";
import { isPaymentRequiredV2 } from "@x402/core/schemas";
import {
  buildPaymentRequired,
  extractClaimedSigner,
  makeAuthorizationState,
  settlePayment,
  verifyPayment,
  X402PaymentError,
} from "./facilitator";
import {
  X402_SEPOLIA_FACILITATOR,
  X402_SEPOLIA_NETWORK,
  X402_SEPOLIA_USDC,
  type X402Config,
} from "./env";

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

describe("x402 facilitator wrapper", () => {
  it("builds the v2 payment-required payload", () => {
    const paymentRequired = buildPaymentRequired(config, "https://example.test/api/v1/review/x402");

    expect(isPaymentRequiredV2(paymentRequired)).toBe(true);
    expect(paymentRequired).toMatchObject({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:84532",
          asset: X402_SEPOLIA_USDC,
          amount: "500000",
          payTo: config.treasury,
          extra: { name: "USDC", version: "2" },
        },
      ],
      resource: {
        url: "https://example.test/api/v1/review/x402",
        mimeType: "application/json",
      },
      error: "PAYMENT-REQUIRED",
    });
  });

  it("verifies and persists a bounded authorization window", async () => {
    const now = new Date("2026-05-29T00:00:00Z");
    const payload = {
      authorization: {
        from: "0x0000000000000000000000000000000000000001",
        validAfter: Math.floor(now.getTime() / 1000),
        validBefore: Math.floor(now.getTime() / 1000) + 600,
      },
    };
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }),
    );

    const verified = await verifyPayment({
      paymentSignature: Buffer.from(JSON.stringify(payload)).toString("base64"),
      config,
      resource: "https://example.test/api/v1/review/x402",
      now,
      fetchImpl,
    });

    expect(verified.callerWallet).toBe("0x0000000000000000000000000000000000000001");
    expect(makeAuthorizationState(verified).validBefore).toBe("2026-05-29T00:10:00.000Z");
    expect(makeAuthorizationState(verified).resource).toBe(
      "https://example.test/api/v1/review/x402",
    );
    expect(fetchImpl).toHaveBeenCalledWith(`${X402_SEPOLIA_FACILITATOR}/verify`, expect.anything());
  });

  it("extracts only authorization.from for pre-verify signer attribution", () => {
    const payload = {
      signer: "0x0000000000000000000000000000000000000002",
      authorization: {
        from: "0x0000000000000000000000000000000000000001",
      },
    };

    expect(extractClaimedSigner(Buffer.from(JSON.stringify(payload)).toString("base64"))).toBe(
      "0x0000000000000000000000000000000000000001",
    );
  });

  it("uses authorization.from instead of loose signer fields after verification", async () => {
    const now = new Date("2026-05-29T00:00:00Z");
    const payload = {
      signer: "0x0000000000000000000000000000000000000002",
      authorization: {
        from: "0x0000000000000000000000000000000000000001",
        validAfter: Math.floor(now.getTime() / 1000),
        validBefore: Math.floor(now.getTime() / 1000) + 600,
      },
    };

    const verified = await verifyPayment({
      paymentSignature: Buffer.from(JSON.stringify(payload)).toString("base64"),
      config,
      resource: "https://example.test/api/v1/review/x402",
      now,
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              isValid: true,
              signer: "0x0000000000000000000000000000000000000002",
            }),
            { status: 200 },
          ),
      ),
    });

    expect(verified.callerWallet).toBe("0x0000000000000000000000000000000000000001");
  });

  it("ignores decoy authorization windows outside the authorization object", async () => {
    const now = new Date("2026-05-29T00:00:00Z");
    const payload = {
      validAfter: Math.floor(now.getTime() / 1000),
      validBefore: Math.floor(now.getTime() / 1000) + 901,
      nested: {
        validBefore: Math.floor(now.getTime() / 1000) - 1,
      },
      authorization: {
        from: "0x0000000000000000000000000000000000000001",
        validAfter: Math.floor(now.getTime() / 1000),
        validBefore: Math.floor(now.getTime() / 1000) + 600,
      },
    };

    const verified = await verifyPayment({
      paymentSignature: Buffer.from(JSON.stringify(payload)).toString("base64"),
      config,
      resource: "https://example.test/api/v1/review/x402",
      now,
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }),
      ),
    });

    expect(verified.validBefore.toISOString()).toBe("2026-05-29T00:10:00.000Z");
  });

  it("rejects authorization windows over 900 seconds", async () => {
    const now = new Date("2026-05-29T00:00:00Z");
    const payload = {
      authorization: {
        from: "0x0000000000000000000000000000000000000001",
        validAfter: Math.floor(now.getTime() / 1000),
        validBefore: Math.floor(now.getTime() / 1000) + 901,
      },
    };

    await expect(
      verifyPayment({
        paymentSignature: Buffer.from(JSON.stringify(payload)).toString("base64"),
        config,
        resource: "https://example.test/api/v1/review/x402",
        now,
        fetchImpl: vi.fn(
          async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }),
        ),
      }),
    ).rejects.toMatchObject({
      code: "x402_authorization_window_too_long",
    } satisfies Partial<X402PaymentError>);
  });

  it("rejects HTTP-success verify responses without explicit validity", async () => {
    const now = new Date("2026-05-29T00:00:00Z");
    const payload = {
      authorization: {
        from: "0x0000000000000000000000000000000000000001",
        validAfter: Math.floor(now.getTime() / 1000),
        validBefore: Math.floor(now.getTime() / 1000) + 600,
      },
    };

    await expect(
      verifyPayment({
        paymentSignature: Buffer.from(JSON.stringify(payload)).toString("base64"),
        config,
        resource: "https://example.test/api/v1/review/x402",
        now,
        fetchImpl: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
      }),
    ).rejects.toMatchObject({
      code: "x402_verify_failed",
    } satisfies Partial<X402PaymentError>);
  });

  it("settles only when the facilitator response explicitly succeeds", async () => {
    const authorization = {
      kind: "x402_authorization" as const,
      paymentPayload: { authorization: {} },
      paymentPayloadBase64: "e30=",
      validAfter: "2026-05-29T00:00:00.000Z",
      validBefore: "2026-05-29T00:10:00.000Z",
      resource: "https://example.test/api/v1/review/x402",
      verifyResponse: { isValid: true },
    };
    let observedAmount: string | null = null;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        paymentRequirements: { amount: string };
      };
      observedAmount = request.paymentRequirements.amount;
      return new Response(
        JSON.stringify({ success: true, transaction: "0xabc", network: "eip155:84532" }),
        {
          status: 200,
        },
      );
    });

    const result = await settlePayment({
      job: { x402PayTo: config.treasury } as never,
      config,
      authorization,
      now: new Date("2026-05-29T00:05:00Z"),
      fetchImpl,
    });

    expect(result.settled).toBe(true);
    expect(observedAmount).toBe("500000");
  });

  it("rejects HTTP-success settle responses when success is false", async () => {
    const authorization = {
      kind: "x402_authorization" as const,
      paymentPayload: { authorization: {} },
      paymentPayloadBase64: "e30=",
      validAfter: "2026-05-29T00:00:00.000Z",
      validBefore: "2026-05-29T00:10:00.000Z",
      resource: "https://example.test/api/v1/review/x402",
      verifyResponse: { isValid: true },
    };

    await expect(
      settlePayment({
        job: { x402PayTo: config.treasury } as never,
        config,
        authorization,
        now: new Date("2026-05-29T00:05:00Z"),
        fetchImpl: vi.fn(
          async () =>
            new Response(JSON.stringify({ success: false, errorReason: "insufficient_funds" }), {
              status: 200,
            }),
        ),
      }),
    ).rejects.toMatchObject({
      code: "x402_settle_failed",
    } satisfies Partial<X402PaymentError>);
  });
});
