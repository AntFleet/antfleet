import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { AUTONOMOPOLY_AGENT } from "@/lib/agent-registry";
import { requireCronAuth } from "@/lib/cron-auth";
import { backfillIdentityDrift } from "@/lib/identity-drift";
import { logError, logInfo, messageOf } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireCronAuth(req, {
    missingEvent: "drift_cron.misconfigured",
    unauthorizedEvent: "drift_cron.unauthorized",
  });
  if (auth !== null) return auth;

  const t0 = Date.now();
  try {
    const result = await backfillIdentityDrift(AUTONOMOPOLY_AGENT);
    const elapsedMs = Date.now() - t0;
    logInfo("drift_cron.complete", { ...result, elapsedMs });
    return NextResponse.json({ ...result, elapsedMs });
  } catch (err) {
    const message = messageOf(err);
    logError("drift_cron.failed", { message });
    return new NextResponse("drift tick failed", { status: 500 });
  }
}
