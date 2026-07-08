import { describe, expect, it } from "vitest";
import { mintAeonContextToken, requireAeonContext, verifyAeonContext } from "./aeon-gate";

function req(token: string | null) {
  return {
    headers: new Headers(token === null ? {} : { "x-aeon-context": token }),
  };
}

describe("requireAeonContext", () => {
  it("accepts a valid HMAC token", () => {
    const now = new Date("2026-05-29T00:00:00Z");
    const timestamp = Math.floor(now.getTime() / 1000);
    const token = mintAeonContextToken({
      kid: "k1",
      secret: "secret",
      sessionId: "session-1",
      timestamp,
    });

    const result = requireAeonContext(req(token), {
      now: () => now,
      env: { AEON_GATE_SECRETS: JSON.stringify([{ kid: "k1", secret: "secret" }]) },
    });

    expect(result).toEqual({ ok: true, required: true, sessionId: "session-1", kid: "k1" });
  });

  it("rejects missing and expired tokens with the same envelope code", () => {
    const now = new Date("2026-05-29T00:00:00Z");
    const expired = mintAeonContextToken({
      kid: "k1",
      secret: "secret",
      sessionId: "session-1",
      timestamp: Math.floor(now.getTime() / 1000) - 301,
    });
    const deps = {
      now: () => now,
      env: { AEON_GATE_SECRETS: JSON.stringify([{ kid: "k1", secret: "secret" }]) },
    };

    expect(requireAeonContext(req(null), deps)).toMatchObject({
      ok: false,
      code: "aeon_context_required",
    });
    expect(requireAeonContext(req(expired), deps)).toMatchObject({
      ok: false,
      code: "aeon_context_required",
    });
  });

  it("no-ops when the removability flag is false", () => {
    const result = requireAeonContext(req(null), {
      now: () => new Date("2026-05-29T00:00:00Z"),
      env: { X402_REQUIRE_AEON_CONTEXT: "false" },
    });

    expect(result).toEqual({ ok: true, required: false, sessionId: null, kid: null });
  });
});

describe("verifyAeonContext", () => {
  it("validates tokens even when the global gate is open", () => {
    const now = new Date("2026-05-29T00:00:00Z");
    const token = mintAeonContextToken({
      kid: "k1",
      secret: "secret",
      sessionId: "session-1",
      timestamp: Math.floor(now.getTime() / 1000),
    });
    const deps = {
      now: () => now,
      env: { AEON_GATE_SECRETS: JSON.stringify([{ kid: "k1", secret: "secret" }]) },
    };

    expect(verifyAeonContext(req(token), deps)).toEqual({
      ok: true,
      sessionId: "session-1",
      kid: "k1",
    });
    expect(verifyAeonContext(req(null), deps)).toMatchObject({
      ok: false,
      code: "aeon_context_required",
    });
  });
});
