import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetRateLimitForTest, checkRateLimit } from "./rate-limit";

const VALID_SALT = "0123456789abcdef";

describe("api v1 rate limit", () => {
  const originalSalt = process.env["ROAST_IP_SALT"];

  beforeEach(() => {
    process.env["ROAST_IP_SALT"] = VALID_SALT;
    resetRateLimitForTest();
  });

  afterEach(() => {
    if (originalSalt === undefined) {
      delete process.env["ROAST_IP_SALT"];
    } else {
      process.env["ROAST_IP_SALT"] = originalSalt;
    }
    resetRateLimitForTest();
  });

  it("allows 60 requests in a minute and limits the 61st", () => {
    const now = 1_000;

    for (let i = 0; i < 60; i += 1) {
      expect(checkRateLimit("203.0.113.10", now)).toEqual({
        allowed: true,
        retryAfterSec: 0,
      });
    }

    const limited = checkRateLimit("203.0.113.10", now);
    expect(limited.allowed).toBe(false);
    expect(limited.retryAfterSec).toBeGreaterThan(0);
  });

  it("isolates counters for different IPs", () => {
    const now = 1_000;

    for (let i = 0; i < 60; i += 1) {
      expect(checkRateLimit("203.0.113.10", now).allowed).toBe(true);
    }

    expect(checkRateLimit("203.0.113.10", now).allowed).toBe(false);
    expect(checkRateLimit("203.0.113.11", now)).toEqual({
      allowed: true,
      retryAfterSec: 0,
    });
  });

  it("allows requests again after the 60 second window elapses", () => {
    const start = 1_000;

    for (let i = 0; i < 60; i += 1) {
      expect(checkRateLimit("203.0.113.10", start).allowed).toBe(true);
    }

    expect(checkRateLimit("203.0.113.10", start).allowed).toBe(false);
    expect(checkRateLimit("203.0.113.10", start + 60_000)).toEqual({
      allowed: true,
      retryAfterSec: 0,
    });
  });

  it("throws when ROAST_IP_SALT is missing or too short", () => {
    delete process.env["ROAST_IP_SALT"];
    expect(() => checkRateLimit("203.0.113.10", 1_000)).toThrow(
      "ROAST_IP_SALT must be set to a >=16 char string",
    );

    process.env["ROAST_IP_SALT"] = "too-short";
    expect(() => checkRateLimit("203.0.113.10", 1_000)).toThrow(
      "ROAST_IP_SALT must be set to a >=16 char string",
    );
  });
});
