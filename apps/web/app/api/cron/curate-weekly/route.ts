import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { logError } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireCronAuth(req, {
    missingEvent: "curate_weekly_cron.misconfigured",
    unauthorizedEvent: "curate_weekly_cron.unauthorized",
  });
  if (auth !== null) return auth;

  // Neon DB access is intentionally disabled: see apps/web/db/index.ts for
  // why. This route opened its own per-request Pool (bypassing that guard),
  // so it needs the same short-circuit to keep it from ever reaching Neon.
  // Revert this commit to restore live DB access.
  logError("curate_weekly_cron.misconfigured", { reason: "Neon DB access is disabled" });
  return new NextResponse("server misconfigured", { status: 500 });
}
