import type { ReviewJobRow } from "@/lib/review-job-queries";
import {
  X402_AUTHORIZATION_MAX_SECONDS,
  X402_FUTURE_SKEW_SECONDS,
  X402_MAX_TIMEOUT_SECONDS,
  type X402Config,
} from "./env";

export const PAYMENT_SIGNATURE_HEADER = "payment-signature";
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

export type VerifiedPayment = {
  callerWallet: string;
  payload: unknown;
  payloadBase64: string;
  validAfter: Date;
  validBefore: Date;
  resource: string;
  facilitatorResponse: unknown;
};

export type X402AuthorizationState = {
  kind: "x402_authorization";
  paymentPayload: unknown;
  paymentPayloadBase64: string;
  validAfter: string;
  validBefore: string;
  resource: string;
  verifyResponse: unknown;
};

export type SettlementResult = {
  settled: boolean;
  paymentResponseHeader: string | null;
  response: unknown;
};

export class X402PaymentError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// Overrides for the resource a payment authorization is bound to. Defaults
// describe the per-PR review; the repo-scan endpoint passes its own price +
// description so a single buyer-signed authorization covers a full scan.
export type PaymentResourceOptions = {
  amountBaseUnits?: string;
  description?: string;
  serviceName?: string;
  tags?: string[];
};

export function buildPaymentRequired(
  config: X402Config,
  resource: string,
  opts: PaymentResourceOptions = {},
) {
  return {
    x402Version: 2,
    resource: {
      url: resource,
      description: opts.description ?? "AntFleet two-model-consensus PR review (Opus 4.7 + GPT-5)",
      mimeType: "application/json",
      serviceName: opts.serviceName ?? "AntFleet PR Review",
      tags: opts.tags ?? ["pr-review", "antfleet"],
    },
    accepts: [
      {
        scheme: "exact",
        network: config.network,
        asset: config.usdcAsset,
        amount: opts.amountBaseUnits ?? config.priceBaseUnits,
        payTo: config.treasury,
        maxTimeoutSeconds: X402_MAX_TIMEOUT_SECONDS,
        extra: eip3009DomainExtra(config.network),
      },
    ],
    error: "PAYMENT-REQUIRED",
  };
}

// Repo-scan flavour of the payment requirements: charges config.repoScanPriceUsdc
// (flat per-scan price) instead of the per-PR review price.
export function buildScanPaymentRequired(config: X402Config, resource: string) {
  return buildPaymentRequired(config, resource, {
    amountBaseUnits: config.repoScanPriceBaseUnits,
    description:
      "AntFleet repo vulnerability scan — semantic chunking + two-model consensus (up to 10 chunks)",
    serviceName: "AntFleet Repo Scan",
    tags: ["repo-scan", "antfleet"],
  });
}

function eip3009DomainExtra(network: X402Config["network"]): { name: string; version: string } {
  return network === "eip155:8453"
    ? { name: "USD Coin", version: "2" }
    : { name: "USDC", version: "2" };
}

export async function verifyPayment(args: {
  paymentSignature: string;
  config: X402Config;
  resource: string;
  now: Date;
  fetchImpl?: typeof fetch;
  // Prebuilt accepts[0] requirements. The repo-scan route passes its own
  // (scan price + description) so verification checks the signed authorization
  // against the amount the buyer was quoted. Defaults to the per-PR review
  // requirements when omitted.
  paymentRequirements?: unknown;
}): Promise<VerifiedPayment> {
  const payload = decodeBase64Json(args.paymentSignature);
  const resp = await (args.fetchImpl ?? fetch)(`${args.config.facilitator}/verify`, {
    method: "POST",
    headers: facilitatorHeaders(args.config),
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements:
        args.paymentRequirements ?? buildPaymentRequired(args.config, args.resource).accepts[0],
    }),
  });
  const body = await readJsonBody(resp);
  if (!resp.ok || !isVerificationValid(body)) {
    throw new X402PaymentError(402, "x402_verify_failed", "x402 payment verification failed");
  }

  const callerWallet = extractCallerWallet(body) ?? extractCallerWallet(payload);
  if (callerWallet === null) {
    throw new X402PaymentError(
      400,
      "x402_signer_missing",
      "verified payment did not include signer",
    );
  }

  const window = extractAuthorizationWindow(payload, body);
  enforceAuthorizationWindow(window, args.now);

  return {
    callerWallet: callerWallet.toLowerCase(),
    payload,
    payloadBase64: args.paymentSignature,
    validAfter: window.validAfter,
    validBefore: window.validBefore,
    resource: args.resource,
    facilitatorResponse: body,
  };
}

export async function settlePayment(args: {
  job: Pick<ReviewJobRow, "x402PayTo">;
  config: X402Config;
  authorization: X402AuthorizationState;
  now: Date;
  fetchImpl?: typeof fetch;
  // Prebuilt accepts[0] requirements, mirroring verifyPayment. Must match what
  // verification used (same amount/description) or the facilitator rejects the
  // settle. Defaults to the per-PR review requirements when omitted.
  paymentRequirements?: unknown;
}): Promise<SettlementResult> {
  if (args.job.x402PayTo !== args.config.treasury) {
    throw new X402PaymentError(500, "x402_pay_to_mismatch", "x402 payTo changed after verify");
  }
  if (args.now.getTime() > new Date(args.authorization.validBefore).getTime()) {
    throw new X402PaymentError(409, "x402_authorization_expired", "x402 authorization expired");
  }

  const resp = await (args.fetchImpl ?? fetch)(`${args.config.facilitator}/settle`, {
    method: "POST",
    headers: facilitatorHeaders(args.config),
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload: args.authorization.paymentPayload,
      paymentRequirements:
        args.paymentRequirements ??
        buildPaymentRequired(args.config, args.authorization.resource).accepts[0],
    }),
  });
  const body = await readJsonBody(resp);
  if (!resp.ok || !isSettlementSuccessful(body)) {
    throw new X402PaymentError(502, "x402_settle_failed", settlementErrorMessage(body));
  }

  return {
    settled: true,
    paymentResponseHeader: paymentResponseHeader(body),
    response: body,
  };
}

export function paymentResponseHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

export function makeAuthorizationState(payment: VerifiedPayment): X402AuthorizationState {
  return {
    kind: "x402_authorization",
    paymentPayload: payment.payload,
    paymentPayloadBase64: payment.payloadBase64,
    validAfter: payment.validAfter.toISOString(),
    validBefore: payment.validBefore.toISOString(),
    resource: payment.resource,
    verifyResponse: payment.facilitatorResponse,
  };
}

/**
 * Extract the claimed signer address from a PAYMENT-SIGNATURE header without
 * cryptographic verification. This is only for pre-verify rate-limit and
 * idempotency lookups; verifyPayment remains the authority before enqueue.
 */
export function extractClaimedSigner(headerValue: string | null): `0x${string}` | null {
  if (headerValue === null || headerValue.trim() === "") return null;
  try {
    const decoded = JSON.parse(Buffer.from(headerValue, "base64").toString("utf8")) as unknown;
    const from = readAuthorizationFrom(decoded);
    return from === null ? null : (from.toLowerCase() as `0x${string}`);
  } catch {
    return null;
  }
}

export function readAuthorizationState(value: unknown): X402AuthorizationState | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record["kind"] !== "x402_authorization") return null;
  if (
    typeof record["paymentPayloadBase64"] !== "string" ||
    typeof record["validAfter"] !== "string" ||
    typeof record["validBefore"] !== "string" ||
    typeof record["resource"] !== "string"
  ) {
    return null;
  }
  return {
    kind: "x402_authorization",
    paymentPayload: record["paymentPayload"],
    paymentPayloadBase64: record["paymentPayloadBase64"],
    validAfter: record["validAfter"],
    validBefore: record["validBefore"],
    resource: record["resource"],
    verifyResponse: record["verifyResponse"],
  };
}

function enforceAuthorizationWindow(
  window: { validAfter: Date; validBefore: Date },
  now: Date,
): void {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const validAfterSeconds = Math.floor(window.validAfter.getTime() / 1000);
  const validBeforeSeconds = Math.floor(window.validBefore.getTime() / 1000);
  if (validBeforeSeconds <= nowSeconds) {
    throw new X402PaymentError(400, "x402_authorization_expired", "x402 authorization expired");
  }
  if (validAfterSeconds > nowSeconds + X402_FUTURE_SKEW_SECONDS) {
    throw new X402PaymentError(
      400,
      "x402_authorization_not_yet_valid",
      "x402 authorization starts too far in the future",
    );
  }
  if (validBeforeSeconds - nowSeconds > X402_AUTHORIZATION_MAX_SECONDS) {
    throw new X402PaymentError(
      400,
      "x402_authorization_window_too_long",
      "Authorization validBefore - now exceeds 900s; skill must set validBefore = now + 600s",
    );
  }
}

function decodeBase64Json(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as unknown;
  } catch {
    throw new X402PaymentError(400, "x402_payment_payload_invalid", "invalid PAYMENT-SIGNATURE");
  }
}

function extractAuthorizationWindow(
  payload: unknown,
  verifyResponse: unknown,
): { validAfter: Date; validBefore: Date } {
  const validAfter =
    readAuthorizationNumber(payload, "validAfter") ??
    readAuthorizationNumber(verifyResponse, "validAfter");
  const validBefore =
    readAuthorizationNumber(payload, "validBefore") ??
    readAuthorizationNumber(verifyResponse, "validBefore");
  if (validAfter === null || validBefore === null) {
    throw new X402PaymentError(
      400,
      "x402_authorization_window_missing",
      "x402 authorization window missing",
    );
  }
  return { validAfter: new Date(validAfter * 1000), validBefore: new Date(validBefore * 1000) };
}

function readAuthorizationNumber(value: unknown, key: "validAfter" | "validBefore"): number | null {
  if (typeof value !== "object" || value === null) return null;
  const authorization = (value as Record<string, unknown>)["authorization"];
  if (typeof authorization !== "object" || authorization === null) return null;
  const direct = (authorization as Record<string, unknown>)[key];
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  if (typeof direct === "string" && /^\d+$/u.test(direct)) return Number(direct);
  return null;
}

function extractCallerWallet(value: unknown): string | null {
  return readAuthorizationFrom(value);
}

function readAuthorizationFrom(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const authorization = (value as Record<string, unknown>)["authorization"];
  if (typeof authorization !== "object" || authorization === null) return null;
  const from = (authorization as Record<string, unknown>)["from"];
  return typeof from === "string" && /^0x[a-fA-F0-9]{40}$/.test(from) ? from : null;
}

function isVerificationValid(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record["isValid"] === true || record["valid"] === true || record["success"] === true;
}

function isSettlementSuccessful(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return (value as Record<string, unknown>)["success"] === true;
}

function settlementErrorMessage(value: unknown): string {
  if (typeof value !== "object" || value === null) return "x402 settlement failed";
  const record = value as Record<string, unknown>;
  const reason = record["errorReason"] ?? record["error"] ?? record["code"];
  const message = record["errorMessage"] ?? record["message"];
  if (typeof reason === "string" && typeof message === "string") {
    return `x402 settlement failed: ${reason}: ${message}`;
  }
  if (typeof reason === "string") return `x402 settlement failed: ${reason}`;
  if (typeof message === "string") return `x402 settlement failed: ${message}`;
  return "x402 settlement failed";
}

function facilitatorHeaders(config: X402Config): HeadersInit {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.cdpApiKeyId !== null) headers["x-cdp-api-key-id"] = config.cdpApiKeyId;
  if (config.cdpApiKeySecret !== null) headers["x-cdp-api-key-secret"] = config.cdpApiKeySecret;
  return headers;
}

async function readJsonBody(resp: Response): Promise<unknown> {
  const text = await resp.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}
