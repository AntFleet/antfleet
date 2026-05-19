import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { __resetRateLimitForTest } from "../../../lib/api-v1/rate-limit";
import { middleware } from "../../../middleware";

function req(): NextRequest {
  return new NextRequest("https://www.antfleet.dev/api/v1/findings", {
    method: "GET",
    headers: { "x-forwarded-for": "203.0.113.10" },
  });
}

describe("api v1 rate limit integration", () => {
  beforeEach(() => {
    process.env["ROAST_IP_SALT"] = "0123456789abcdef";
    __resetRateLimitForTest();
  });

  it("allows requests 1-60 and returns the documented 429 response on request 61", async () => {
    for (let i = 0; i < 60; i += 1) {
      expect(middleware(req()).status).not.toBe(429);
    }

    const limited = middleware(req());

    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^[1-9]\d*$/);
    await expect(limited.json()).resolves.toEqual({
      error: {
        code: "rate_limited",
        message: "max 60 requests per minute per ip",
      },
    });
  });
});
