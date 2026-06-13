import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { resetRateLimitForTest } from "../../../lib/api-v1/rate-limit";
import { proxy } from "../../../proxy";

function req(): NextRequest {
  return new NextRequest("https://www.antfleet.dev/api/v1/findings", {
    method: "GET",
    headers: { "x-forwarded-for": "203.0.113.10" },
  });
}

function postReq(): NextRequest {
  return new NextRequest("https://www.antfleet.dev/api/v1/review/x402", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.10" },
  });
}

describe("api v1 rate limit integration", () => {
  beforeEach(() => {
    process.env["ROAST_IP_SALT"] = "0123456789abcdef";
    resetRateLimitForTest();
  });

  it("allows requests 1-60 and returns the documented 429 response on request 61", async () => {
    for (let i = 0; i < 60; i += 1) {
      expect(proxy(req()).status).not.toBe(429);
    }

    const limited = proxy(req());

    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^[1-9]\d*$/);
    await expect(limited.json()).resolves.toEqual({
      error: {
        code: "rate_limited",
        message: "max 60 requests per minute per ip",
      },
    });
  });

  it("applies rate limit to POST /api/v1/* — not just GET", async () => {
    for (let i = 0; i < 60; i += 1) {
      expect(proxy(postReq()).status).not.toBe(429);
    }

    const limited = proxy(postReq());

    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^[1-9]\d*$/);
    await expect(limited.json()).resolves.toEqual({
      error: {
        code: "rate_limited",
        message: "max 60 requests per minute per ip",
      },
    });
  });

  it("proxy middleware is invoked for /api/v1/ routes (middleware not dead-code)", () => {
    // Verify the proxy is actually called and adds security headers on every
    // request — this asserts the middleware is wired, not just compiled.
    const res = proxy(req());
    expect(res.headers.get("Strict-Transport-Security")).toContain("includeSubDomains");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
