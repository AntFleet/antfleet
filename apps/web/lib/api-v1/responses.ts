import { NextResponse } from "next/server";

export const LIST_CACHE = "public, s-maxage=60, stale-while-revalidate=300";
export const DETAIL_CACHE = "public, s-maxage=300, stale-while-revalidate=3600";
export const NO_STORE = "no-store";

function jsonHeaders(cacheControl: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": cacheControl,
    "Content-Type": "application/json; charset=utf-8",
  };
}

export function jsonOk(body: unknown, opts: { cacheControl: string }): NextResponse {
  return NextResponse.json(body, {
    status: 200,
    headers: jsonHeaders(opts.cacheControl),
  });
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  extras?: Record<string, unknown>,
): NextResponse {
  const body: Record<string, unknown> = { error: { code, message } };
  if (extras !== undefined) {
    for (const [k, v] of Object.entries(extras)) {
      body[k] = v;
    }
  }
  return NextResponse.json(body, {
    status,
    headers: jsonHeaders(NO_STORE),
  });
}

export function jsonStats(body: unknown): NextResponse {
  return jsonOk(body, { cacheControl: NO_STORE });
}

export function optionsResponse(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}
