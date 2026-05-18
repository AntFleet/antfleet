import { createHmac, timingSafeEqual } from "node:crypto";

// Stateless signed token used by the Onboarder's self-serve
// public-receipts opt-in link. No DB table — the token *is* the bearer
// of the (install, owner, repo) tuple, and the HMAC binds it to the
// server's OPTIN_HMAC_SECRET. Idempotent flip on click means replay
// inside the validity window is a no-op, not an exploit.

export const OPTIN_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type OptInPayload = {
  installationId: number;
  owner: string;
  repo: string;
};

type SignedPayload = OptInPayload & { exp: number };

function getSecret(): string {
  const secret = process.env["OPTIN_HMAC_SECRET"];
  if (secret === undefined || secret.length === 0) {
    throw new Error("OPTIN_HMAC_SECRET is required to sign or verify opt-in tokens");
  }
  return secret;
}

function base64urlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/=+$/u, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}

function base64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/gu, "+").replace(/_/gu, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}

function hmacFor(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function signToken(payload: OptInPayload, now: Date = new Date()): string {
  const signed: SignedPayload = {
    installationId: payload.installationId,
    owner: payload.owner,
    repo: payload.repo,
    exp: now.getTime() + OPTIN_TOKEN_TTL_MS,
  };
  const encodedPayload = base64urlEncode(JSON.stringify(signed));
  const mac = hmacFor(getSecret(), encodedPayload);
  return `${encodedPayload}.${base64urlEncode(mac)}`;
}

export type VerifyResult =
  | { kind: "ok"; payload: OptInPayload }
  | { kind: "expired" }
  | { kind: "invalid" };

export function verifyTokenDetailed(token: string, now: Date = new Date()): VerifyResult {
  if (typeof token !== "string" || token.length === 0) return { kind: "invalid" };
  const dot = token.indexOf(".");
  if (dot === -1 || dot === token.length - 1) return { kind: "invalid" };
  const encodedPayload = token.slice(0, dot);
  const encodedMac = token.slice(dot + 1);

  const expectedMac = hmacFor(getSecret(), encodedPayload);
  let providedMac: Buffer;
  try {
    providedMac = base64urlDecode(encodedMac);
  } catch {
    return { kind: "invalid" };
  }
  if (providedMac.length !== expectedMac.length) return { kind: "invalid" };
  if (!timingSafeEqual(expectedMac, providedMac)) return { kind: "invalid" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64urlDecode(encodedPayload).toString("utf8"));
  } catch {
    return { kind: "invalid" };
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "invalid" };
  const obj = parsed as Record<string, unknown>;
  const installationId = obj["installationId"];
  const owner = obj["owner"];
  const repo = obj["repo"];
  const exp = obj["exp"];
  if (
    typeof installationId !== "number" ||
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    typeof exp !== "number"
  ) {
    return { kind: "invalid" };
  }
  if (now.getTime() >= exp) return { kind: "expired" };
  return { kind: "ok", payload: { installationId, owner, repo } };
}

export function verifyToken(token: string, now: Date = new Date()): OptInPayload | null {
  const result = verifyTokenDetailed(token, now);
  return result.kind === "ok" ? result.payload : null;
}

// Short stable correlation handle for logs. Never log the raw token —
// it's a bearer credential for 30 days.
export function tokenLogId(token: string): string {
  return createHmac("sha256", "antfleet.optin.log").update(token).digest("hex").slice(0, 12);
}

// Build the absolute URL the Onboarder injects into the first-review
// summary comment. action defaults to "enable"; pass "disable" for the
// reversal link.
export function buildOptInUrl(args: {
  baseUrl: string;
  payload: OptInPayload;
  action?: "enable" | "disable";
  now?: Date;
}): string {
  const token = signToken(args.payload, args.now);
  const url = new URL("/api/opt-in", args.baseUrl);
  url.searchParams.set("t", token);
  if (args.action === "disable") {
    url.searchParams.set("action", "disable");
  }
  return url.toString();
}
