import { describe, expect, it } from "vitest";

// The middleware module is intentionally minimal — it sets a header map on
// every NextResponse it returns. These tests guard the header values
// against accidental loosening (e.g., someone adding 'unsafe-eval' to the
// CSP, or downgrading HSTS to a weak max-age).
//
// We import the module's SECURITY_HEADERS map via re-export rather than
// instantiating the full middleware function with mock NextRequest — the
// header values are the load-bearing piece; the rest is plumbing.

import { beforeEach } from "vitest";
import { middleware } from "./middleware";
import type { NextRequest } from "next/server";

function makeReq(): NextRequest {
  return { nextUrl: new URL("https://www.antfleet.dev/") } as unknown as NextRequest;
}

describe("security headers middleware", () => {
  // Per PR #6 review (claude-opus-4-7 + gpt-5 agreed): a single shared
  // response defeats per-test isolation if middleware ever becomes
  // stateful. Re-derive a fresh response inside each `it` via beforeEach
  // so future tests can't silently coupling-pollute each other.
  let res: ReturnType<typeof middleware>;
  beforeEach(() => {
    res = middleware(makeReq());
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
    // Any of these are acceptable; weaker ones (e.g., unsafe-url) are not.
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
