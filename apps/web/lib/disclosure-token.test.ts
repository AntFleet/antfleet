import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signDisclosureToken, verifyDisclosureToken } from "./disclosure-token";

describe("disclosure-token", () => {
  beforeEach(() => {
    process.env["DISCLOSURE_HMAC_SECRET"] = "test-secret";
  });

  afterEach(() => {
    delete process.env["DISCLOSURE_HMAC_SECRET"];
  });

  it("round-trips a signed finding-scoped token", () => {
    const now = new Date("2026-06-23T00:00:00Z");
    const token = signDisclosureToken({ findingId: "finding-1" }, now);

    expect(verifyDisclosureToken(token, now)).toEqual({
      kind: "ok",
      payload: { findingId: "finding-1" },
    });
  });

  it("rejects tampered tokens", () => {
    const token = signDisclosureToken({ findingId: "finding-1" }, new Date("2026-06-23T00:00:00Z"));
    const tampered = `${token.slice(0, -2)}aa`;

    expect(verifyDisclosureToken(tampered, new Date("2026-06-23T00:00:01Z"))).toEqual({
      kind: "invalid",
    });
  });

  it("keeps maintainer links valid through the embargo window", () => {
    const token = signDisclosureToken({ findingId: "finding-1" }, new Date("2026-06-23T00:00:00Z"));

    expect(verifyDisclosureToken(token, new Date("2026-10-20T00:00:00Z"))).toMatchObject({
      kind: "ok",
    });
    expect(verifyDisclosureToken(token, new Date("2026-10-22T00:00:00Z"))).toEqual({
      kind: "expired",
    });
  });
});
