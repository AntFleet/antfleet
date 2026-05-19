import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { AUTONOMOPOLY_AGENT } from "@/lib/agent-registry";
import { backfillIdentityDrift } from "@/lib/identity-drift";
import { logError, logInfo, logWarn, messageOf } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env["CRON_SECRET"];
  if (secret === undefined || secret.length === 0) {
    logError("drift_cron.misconfigured", { reason: "CRON_SECRET missing" });
    return new NextResponse("server misconfigured", { status: 500 });
  }
  const authHeader = req.headers.get("authorization");
  const expected = `Bearer ${secret}`;
  const provided = authHeader ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    logWarn("drift_cron.unauthorized", { hasAuth: authHeader !== null });
    return new NextResponse("unauthorized", { status: 401 });
  }

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
