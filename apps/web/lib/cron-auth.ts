import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { logError, logWarn } from "./log";

type LogFields = Record<string, unknown>;

export type CronAuthOptions = {
  secret?: string | undefined;
  missingEvent: string;
  unauthorizedEvent: string;
  missingFields?: LogFields;
  unauthorizedFields?: LogFields;
  hasAuthMode?: "present" | "nonempty";
};

export function requireCronAuth(req: NextRequest, options: CronAuthOptions): NextResponse | null {
  const secret = options.secret ?? process.env["CRON_SECRET"];
  if (secret === undefined || secret.length === 0) {
    logError(options.missingEvent, {
      reason: "CRON_SECRET missing",
      ...options.missingFields,
    });
    return new NextResponse("server misconfigured", { status: 500 });
  }

  const authHeader = req.headers.get("authorization");
  if (!matchesBearerSecret(authHeader, secret)) {
    logWarn(options.unauthorizedEvent, {
      ...options.unauthorizedFields,
      hasAuth: hasAuth(authHeader, options.hasAuthMode ?? "present"),
    });
    return new NextResponse("unauthorized", { status: 401 });
  }

  return null;
}

function matchesBearerSecret(authHeader: string | null, secret: string): boolean {
  const provided = authHeader ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function hasAuth(authHeader: string | null, mode: "present" | "nonempty"): boolean {
  if (mode === "nonempty") return (authHeader ?? "").length > 0;
  return authHeader !== null;
}
