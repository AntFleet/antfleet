import { beforeEach, describe, expect, it } from "vitest";
import {
  OPTIN_TOKEN_TTL_MS,
  buildOptInUrl,
  signToken,
  tokenLogId,
  verifyToken,
  verifyTokenDetailed,
} from "./optin-token";

const SECRET = "test-secret-do-not-use-in-prod";

beforeEach(() => {
  process.env["OPTIN_HMAC_SECRET"] = SECRET;
});

describe("signToken / verifyToken", () => {
  const payload = { installationId: 12345, owner: "AntFleet", repo: "antfleet" };

  it("round-trips payload", () => {
    const token = signToken(payload);
    expect(verifyToken(token)).toEqual(payload);
  });

  it("produces token in <base64url>.<base64url> shape", () => {
    const token = signToken(payload);
    const parts = token.split(".");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(parts[1]).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("rejects expired token", () => {
    const long_ago = new Date(Date.now() - 2 * OPTIN_TOKEN_TTL_MS);
    const token = signToken(payload, long_ago);
    expect(verifyToken(token)).toBeNull();
    expect(verifyTokenDetailed(token)).toEqual({ kind: "expired" });
  });

  it("verifyTokenDetailed distinguishes expired from invalid", () => {
    const token = signToken(payload);
    expect(verifyTokenDetailed(token)).toEqual({ kind: "ok", payload });
    expect(verifyTokenDetailed("garbage.token")).toEqual({ kind: "invalid" });
  });

  it("rejects token with tampered HMAC", () => {
    const token = signToken(payload);
    const [body, mac] = token.split(".");
    // Flip a character in the mac segment.
    const tamperedChar = mac!.charAt(0) === "A" ? "B" : "A";
    const tampered = `${body}.${tamperedChar}${mac!.slice(1)}`;
    expect(verifyToken(tampered)).toBeNull();
  });

  it("rejects token with tampered payload", () => {
    const token = signToken(payload);
    const [body, mac] = token.split(".");
    // Decode, mutate installationId, re-encode (without re-signing).
    const decoded = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
    decoded.installationId = decoded.installationId + 1;
    const reencoded = Buffer.from(JSON.stringify(decoded), "utf8")
      .toString("base64")
      .replace(/=+$/u, "")
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_");
    const tampered = `${reencoded}.${mac}`;
    expect(verifyToken(tampered)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyToken("")).toBeNull();
    expect(verifyToken("nodothere")).toBeNull();
    expect(verifyToken("body.")).toBeNull();
    expect(verifyToken(".onlymac")).toBeNull();
  });

  it("throws if OPTIN_HMAC_SECRET is missing at sign time", () => {
    delete process.env["OPTIN_HMAC_SECRET"];
    expect(() => signToken(payload)).toThrow(/OPTIN_HMAC_SECRET/u);
  });

  it("throws if OPTIN_HMAC_SECRET is missing at verify time", () => {
    const token = signToken(payload);
    delete process.env["OPTIN_HMAC_SECRET"];
    expect(() => verifyToken(token)).toThrow(/OPTIN_HMAC_SECRET/u);
  });

  it("token from one secret does not verify under another", () => {
    const token = signToken(payload);
    process.env["OPTIN_HMAC_SECRET"] = "different-secret";
    expect(verifyToken(token)).toBeNull();
  });

  it("preserves owner and repo verbatim including hyphens and slashes-safe input", () => {
    const out = signToken({
      installationId: 999,
      owner: "Liquid-Protocol-Ops",
      repo: "agent-autonomopoly",
    });
    expect(verifyToken(out)).toEqual({
      installationId: 999,
      owner: "Liquid-Protocol-Ops",
      repo: "agent-autonomopoly",
    });
  });
});

describe("buildOptInUrl", () => {
  const payload = { installationId: 12345, owner: "AntFleet", repo: "antfleet" };

  it("builds an /api/opt-in URL with token in query string", () => {
    const url = buildOptInUrl({ baseUrl: "https://www.antfleet.dev", payload });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://www.antfleet.dev");
    expect(parsed.pathname).toBe("/api/opt-in");
    expect(parsed.searchParams.get("t")).not.toBeNull();
    expect(parsed.searchParams.get("action")).toBeNull();
  });

  it("includes action=disable when requested", () => {
    const url = buildOptInUrl({
      baseUrl: "https://www.antfleet.dev",
      payload,
      action: "disable",
    });
    expect(new URL(url).searchParams.get("action")).toBe("disable");
  });

  it("produces a token verifiable by verifyToken", () => {
    const url = buildOptInUrl({ baseUrl: "https://www.antfleet.dev", payload });
    const token = new URL(url).searchParams.get("t")!;
    expect(verifyToken(token)).toEqual(payload);
  });
});

describe("tokenLogId", () => {
  it("returns a 12-char stable hex digest", () => {
    process.env["OPTIN_HMAC_SECRET"] = SECRET;
    const token = signToken({ installationId: 1, owner: "a", repo: "b" });
    const id = tokenLogId(token);
    expect(id).toMatch(/^[0-9a-f]{12}$/u);
    expect(tokenLogId(token)).toBe(id);
  });

  it("differs for different tokens", () => {
    const a = signToken({ installationId: 1, owner: "a", repo: "b" });
    const b = signToken({ installationId: 2, owner: "a", repo: "b" });
    expect(tokenLogId(a)).not.toBe(tokenLogId(b));
  });
});
