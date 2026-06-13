import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { resetRateLimitForTest } from "./lib/api-v1/rate-limit";
import { proxy } from "./proxy";

function makeReq(
  pathname = "/",
  init: { method?: string; headers?: Record<string, string> } = {},
): NextRequest {
  return new NextRequest(`https://www.antfleet.dev${pathname}`, {
    method: init.method ?? "GET",
    headers: init.headers,
  });
}

describe("security headers proxy", () => {
  let res: ReturnType<typeof proxy>;

  beforeEach(() => {
    process.env["ROAST_IP_SALT"] = "0123456789abcdef";
    resetRateLimitForTest();
    res = proxy(makeReq());
  });

  it("sets HSTS for at least 1 year and includes subdomains", () => {
    const hsts = res.headers.get("Strict-Transport-Security");
    expect(hsts).not.toBeNull();
    const maxAgeMatch = hsts?.match(/max-age=(\d+)/);
    expect(maxAgeMatch).not.toBeNull();
    expect(Number(maxAgeMatch?.[1] ?? 0)).toBeGreaterThanOrEqual(31536000);
    expect(hsts).toContain("includeSubDomains");
  });

  it("locks X-Frame-Options to DENY (no embedding allowed)", () => {
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("sets X-Content-Type-Options to nosniff", () => {
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("Referrer-Policy is at least as strict as strict-origin-when-cross-origin", () => {
    const ref = res.headers.get("Referrer-Policy");
    expect(ref).not.toBeNull();
    const strict = [
      "no-referrer",
      "same-origin",
      "strict-origin",
      "strict-origin-when-cross-origin",
    ];
    expect(strict).toContain(ref);
  });

  it("CSP frame-ancestors blocks framing entirely", () => {
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("CSP does not include unsafe-eval", () => {
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("CSP default-src is self only", () => {
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toContain("default-src 'self'");
  });
});

describe("api v1 rate-limit proxy", () => {
  beforeEach(() => {
    process.env["ROAST_IP_SALT"] = "0123456789abcdef";
    resetRateLimitForTest();
  });

  it("returns 429 with Retry-After on the 61st GET /api/v1 request from the same IP", () => {
    let res: ReturnType<typeof proxy> | null = null;

    for (let i = 0; i < 61; i += 1) {
      res = proxy(
        makeReq("/api/v1/findings", {
          headers: { "x-forwarded-for": "203.0.113.10" },
        }),
      );
    }

    expect(res?.status).toBe(429);
    expect(res?.headers.get("Retry-After")).toMatch(/^[1-9]\d*$/);
    expect(res?.headers.get("Strict-Transport-Security")).toContain("includeSubDomains");
  });

  it("prefers single-hop edge client IP headers over spoofable x-forwarded-for", () => {
    let res: ReturnType<typeof proxy> | null = null;

    for (let i = 0; i < 61; i += 1) {
      res = proxy(
        makeReq("/api/v1/findings", {
          headers: {
            "x-real-ip": "198.51.100.20",
            "x-forwarded-for": "203.0.113.10",
          },
        }),
      );
    }

    expect(res?.status).toBe(429);
    const spoofedOnly = proxy(
      makeReq("/api/v1/findings", {
        headers: { "x-forwarded-for": "203.0.113.10" },
      }),
    );
    expect(spoofedOnly.status).not.toBe(429);
  });

  it("does not rate-limit non-api-v1 paths", () => {
    let res: ReturnType<typeof proxy> | null = null;

    for (let i = 0; i < 61; i += 1) {
      res = proxy(
        makeReq("/receipts", {
          headers: { "x-forwarded-for": "203.0.113.10" },
        }),
      );
    }

    expect(res?.status).not.toBe(429);
  });

  it("does not rate-limit OPTIONS preflights", () => {
    let res: ReturnType<typeof proxy> | null = null;

    for (let i = 0; i < 61; i += 1) {
      res = proxy(
        makeReq("/api/v1/findings", {
          method: "OPTIONS",
          headers: { "x-forwarded-for": "203.0.113.10" },
        }),
      );
    }

    expect(res?.status).not.toBe(429);
  });

  it("rate-limits POST /api/v1 requests from the same IP (not just GET)", () => {
    let res: ReturnType<typeof proxy> | null = null;

    for (let i = 0; i < 61; i += 1) {
      res = proxy(
        makeReq("/api/v1/review/x402", {
          method: "POST",
          headers: { "x-forwarded-for": "203.0.113.42" },
        }),
      );
    }

    expect(res?.status).toBe(429);
    expect(res?.headers.get("Retry-After")).toMatch(/^[1-9]\d*$/);
  });

  it("counts GET and POST from the same IP against a shared bucket", () => {
    // 59 GET requests — still under the limit
    for (let i = 0; i < 59; i += 1) {
      proxy(
        makeReq("/api/v1/findings", {
          method: "GET",
          headers: { "x-forwarded-for": "203.0.113.55" },
        }),
      );
    }

    // 60th request is a POST — should be allowed (count hits exactly 60)
    const allowed = proxy(
      makeReq("/api/v1/review/x402", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.55" },
      }),
    );
    expect(allowed.status).not.toBe(429);

    // 61st request triggers the limit
    const limited = proxy(
      makeReq("/api/v1/findings", {
        method: "GET",
        headers: { "x-forwarded-for": "203.0.113.55" },
      }),
    );
    expect(limited.status).toBe(429);
  });
});
