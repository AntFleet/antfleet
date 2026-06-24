import { createHmac, timingSafeEqual } from "node:crypto";

export const SARIF_INGEST_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type SarifIngestAuth = {
  installationId: number;
  owner: string;
  repo: string;
};

type SignedPayload = SarifIngestAuth & { exp: number };

function getSecret(): string {
  const secret = process.env["ANTFLEET_SARIF_INGEST_HMAC_SECRET"];
  if (secret === undefined || secret.length === 0) {
    throw new Error("ANTFLEET_SARIF_INGEST_HMAC_SECRET is required");
  }
  return secret;
}

function hmacFor(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function signSarifIngestToken(payload: SarifIngestAuth, now: Date = new Date()): string {
  const signed: SignedPayload = {
    installationId: payload.installationId,
    owner: payload.owner,
    repo: payload.repo,
    exp: now.getTime() + SARIF_INGEST_TOKEN_TTL_MS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(signed), "utf8").toString("base64url");
  const mac = hmacFor(getSecret(), encodedPayload).toString("base64url");
  return `${encodedPayload}.${mac}`;
}

export type SarifIngestTokenResult =
  | { kind: "ok"; payload: SarifIngestAuth }
  | { kind: "expired" }
  | { kind: "invalid" };

export function verifySarifIngestToken(
  token: string,
  now: Date = new Date(),
): SarifIngestTokenResult {
  const dot = token.indexOf(".");
  if (dot === -1 || dot === token.length - 1) return { kind: "invalid" };
  const encodedPayload = token.slice(0, dot);
  const encodedMac = token.slice(dot + 1);
  const expectedMac = hmacFor(getSecret(), encodedPayload);
  let providedMac: Buffer;
  try {
    providedMac = Buffer.from(encodedMac, "base64url");
  } catch {
    return { kind: "invalid" };
  }
  if (providedMac.length !== expectedMac.length || !timingSafeEqual(providedMac, expectedMac)) {
    return { kind: "invalid" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return { kind: "invalid" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid" };
  }
  const obj = parsed as Record<string, unknown>;
  const installationId = obj["installationId"];
  const owner = obj["owner"];
  const repo = obj["repo"];
  const exp = obj["exp"];
  if (
    typeof installationId !== "number" ||
    !Number.isInteger(installationId) ||
    typeof owner !== "string" ||
    owner.length === 0 ||
    typeof repo !== "string" ||
    repo.length === 0 ||
    typeof exp !== "number"
  ) {
    return { kind: "invalid" };
  }
  if (now.getTime() >= exp) return { kind: "expired" };
  return { kind: "ok", payload: { installationId, owner, repo } };
}
