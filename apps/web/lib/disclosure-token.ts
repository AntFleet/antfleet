import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { EMBARGO_DAYS, MIN_GRACE_DAYS } from "./disclosure-types";

export const DISCLOSURE_TOKEN_TTL_MS = (EMBARGO_DAYS + MIN_GRACE_DAYS) * 24 * 60 * 60 * 1000;

export type DisclosureTokenPayload = {
  findingId: string;
};

type SignedPayload = DisclosureTokenPayload & { exp: number };

function getSecret(): string {
  const secret = process.env["DISCLOSURE_HMAC_SECRET"];
  if (secret === undefined || secret.length === 0) {
    throw new Error("DISCLOSURE_HMAC_SECRET is required");
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

export function signDisclosureToken(
  payload: DisclosureTokenPayload,
  now: Date = new Date(),
): string {
  const signed: SignedPayload = {
    findingId: payload.findingId,
    exp: now.getTime() + DISCLOSURE_TOKEN_TTL_MS,
  };
  const encodedPayload = base64urlEncode(JSON.stringify(signed));
  const mac = hmacFor(getSecret(), encodedPayload);
  return `${encodedPayload}.${base64urlEncode(mac)}`;
}

export type VerifyDisclosureTokenResult =
  | { kind: "ok"; payload: DisclosureTokenPayload }
  | { kind: "expired" }
  | { kind: "invalid" };

export function verifyDisclosureToken(
  token: string,
  now: Date = new Date(),
): VerifyDisclosureTokenResult {
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
  const findingId = obj["findingId"];
  const exp = obj["exp"];
  if (typeof findingId !== "string" || findingId.length === 0 || typeof exp !== "number") {
    return { kind: "invalid" };
  }
  if (now.getTime() >= exp) return { kind: "expired" };
  return { kind: "ok", payload: { findingId } };
}

export function disclosureTokenLogId(token: string): string {
  return createHmac("sha256", "antfleet.disclosure.log").update(token).digest("hex").slice(0, 12);
}

export function encryptDisclosureSecret(value: string): string {
  const key = createHash("sha256").update(getSecret()).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", base64urlEncode(iv), base64urlEncode(tag), base64urlEncode(ciphertext)].join(".");
}

export function decryptDisclosureSecret(value: string): string {
  const [version, ivRaw, tagRaw, ciphertextRaw] = value.split(".");
  if (
    version !== "v1" ||
    ivRaw === undefined ||
    tagRaw === undefined ||
    ciphertextRaw === undefined
  ) {
    throw new Error("invalid disclosure secret ciphertext");
  }
  const key = createHash("sha256").update(getSecret()).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, base64urlDecode(ivRaw));
  decipher.setAuthTag(base64urlDecode(tagRaw));
  const plaintext = Buffer.concat([
    decipher.update(base64urlDecode(ciphertextRaw)),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

export function buildDisclosureUrl(args: {
  baseUrl: string;
  findingId: string;
  now?: Date;
}): string {
  const token = signDisclosureToken({ findingId: args.findingId }, args.now);
  return new URL(`/disclosure/${token}`, args.baseUrl).toString();
}
