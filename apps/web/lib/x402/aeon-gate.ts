import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export const AEON_GATE_ERROR_CODE = "aeon_context_required";
export const AEON_GATE_ERROR_MESSAGE =
  "x402 reviews currently restricted to aeon callers; broader access planned for v2";

export type AeonGateResult =
  | { ok: true; required: true; sessionId: string; kid: string }
  | { ok: true; required: false; sessionId: null; kid: null }
  | { ok: false; code: typeof AEON_GATE_ERROR_CODE; message: typeof AEON_GATE_ERROR_MESSAGE };

export type AeonGateDeps = {
  now: () => Date;
  env: Record<string, string | undefined>;
};

export function requireAeonContext(
  req: Pick<NextRequest, "headers">,
  deps: AeonGateDeps = { now: () => new Date(), env: process.env },
): AeonGateResult {
  if ((deps.env["X402_REQUIRE_AEON_CONTEXT"] ?? "true").toLowerCase() === "false") {
    return { ok: true, required: false, sessionId: null, kid: null };
  }

  const header = req.headers.get("x-aeon-context");
  if (header === null || header.trim() === "") return reject();

  const parsed = parseToken(header.trim());
  if (parsed === null) return reject();

  const secrets = parseSecrets(deps.env["AEON_GATE_SECRETS"]);
  const secret = secrets.get(parsed.kid);
  if (secret === undefined) return reject();

  const nowSeconds = Math.floor(deps.now().getTime() / 1000);
  if (nowSeconds - parsed.timestamp > 300) return reject();
  if (parsed.timestamp - nowSeconds > 30) return reject();

  const signed = `${parsed.kid}:${parsed.sessionId}:${parsed.timestamp}`;
  const expected = createHmac("sha256", secret).update(signed).digest("hex");
  if (!safeEqualHex(expected, parsed.hmac)) return reject();

  return { ok: true, required: true, sessionId: parsed.sessionId, kid: parsed.kid };
}

// Repo-scan flavour of the gate. Same token-verification logic, but the
// default is flipped: the scan endpoint is public from day one, so an UNSET
// X402_REQUIRE_AEON_CONTEXT means "open" (not "gated"). Only an explicit
// "true" turns the aeon requirement on for scans. This deliberately does NOT
// change the PR-review gate, which stays gated-by-default.
export function requireAeonContextForScan(
  req: Pick<NextRequest, "headers">,
  deps: AeonGateDeps = { now: () => new Date(), env: process.env },
): AeonGateResult {
  if ((deps.env["X402_REQUIRE_AEON_CONTEXT"] ?? "false").toLowerCase() !== "true") {
    return { ok: true, required: false, sessionId: null, kid: null };
  }
  return requireAeonContext(req, deps);
}

export function mintAeonContextToken(args: {
  kid: string;
  secret: string;
  sessionId: string;
  timestamp: number;
}): string {
  const signed = `${args.kid}:${args.sessionId}:${args.timestamp}`;
  const hmac = createHmac("sha256", args.secret).update(signed).digest("hex");
  return `${signed}:${hmac}`;
}

function parseToken(
  token: string,
): { kid: string; sessionId: string; timestamp: number; hmac: string } | null {
  const parts = token.split(":");
  if (parts.length !== 4) return null;
  const [kid, sessionId, timestampRaw, hmac] = parts;
  if (
    kid === undefined ||
    sessionId === undefined ||
    timestampRaw === undefined ||
    hmac === undefined
  ) {
    return null;
  }
  if (!/^[A-Za-z0-9-]+$/.test(kid)) return null;
  if (sessionId.length === 0 || sessionId.includes("\n")) return null;
  if (!/^\d+$/.test(timestampRaw)) return null;
  if (!/^[a-f0-9]{64}$/i.test(hmac)) return null;
  return { kid, sessionId, timestamp: Number(timestampRaw), hmac: hmac.toLowerCase() };
}

function parseSecrets(raw: string | undefined): Map<string, string> {
  if (raw === undefined || raw.trim() === "") return new Map();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Map();
    const out = new Map<string, string>();
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const kid = (entry as Record<string, unknown>)["kid"];
      const secret = (entry as Record<string, unknown>)["secret"];
      if (typeof kid === "string" && typeof secret === "string") out.set(kid, secret);
    }
    return out;
  } catch {
    return new Map();
  }
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function reject(): AeonGateResult {
  return { ok: false, code: AEON_GATE_ERROR_CODE, message: AEON_GATE_ERROR_MESSAGE };
}
