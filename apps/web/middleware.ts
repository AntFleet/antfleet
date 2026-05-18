import { NextResponse, type NextRequest } from "next/server";

// Apply baseline security response headers to every request reaching the
// Next.js app. Vercel terminates TLS at the edge, but the headers below
// instruct browsers to keep the connection on HTTPS, refuse to render the
// app inside frames, refuse to MIME-sniff, etc. Standard web hardening
// any b2b buyer's security review expects to see.
//
// API routes that need their own headers (Content-Type for /receipts.rss,
// no-cache for /api/cron/sweep) are not blocked here — middleware merges
// these headers with whatever the route handler returns.

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  // 2 years, includeSubDomains; preload removed deliberately — we have not
  // submitted to the HSTS preload list and shouldn't claim we have.
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // Deny every feature we don't actively use. If we ever need geolocation/camera
  // for a future product surface, this list shrinks accordingly.
  "Permissions-Policy":
    "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), sync-xhr=(), usb=(), web-share=(), xr-spatial-tracking=()",
  // Tight CSP. self for everything; data: for the inline favicon SVG.
  //   script-src: 'self' only — no unsafe-inline, no unsafe-eval.
  //   style-src:  'self' + 'unsafe-inline'. Required because Tailwind v4 +
  //               next/font emit inline <style> blocks during hydration and
  //               removing it would break every Tailwind utility class in
  //               production. The looser style-src is a known trade-off,
  //               not an oversight.
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "),
};

export function middleware(_req: NextRequest): NextResponse {
  const response = NextResponse.next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

// Apply to every path except Next.js internals and static asset files.
// API routes are included — they benefit from the security headers too.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.svg$|.*\\.ico$).*)"],
};
