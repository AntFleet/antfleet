import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { isDisclosureGateEnabled } from "@/lib/daybreak-gates-env";
import { runDisclosureCronTick } from "@/lib/disclosure";
import { logError, logInfo, messageOf } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireCronAuth(req, {
    missingEvent: "disclosure_cron.misconfigured",
    unauthorizedEvent: "disclosure_cron.unauthorized",
  });
  if (auth !== null) return auth;

  if (!isDisclosureGateEnabled()) {
    logInfo("disclosure_cron.skipped", { reason: "feature_flag_disabled" });
    return NextResponse.json({
      scanned: 0,
      expired: 0,
      patchMerged: 0,
      published: 0,
      errors: 0,
      skipped: true,
    });
  }

  const t0 = Date.now();
  try {
    const result = await runDisclosureCronTick(new Date());
    logInfo("disclosure_cron.complete", {
      ...result,
      elapsedMs: Date.now() - t0,
    });
    return NextResponse.json({ ...result, elapsedMs: Date.now() - t0 });
  } catch (err) {
    const message = messageOf(err);
    logError("disclosure_cron.failed", { message });
    return new NextResponse("disclosure cron failed", { status: 500 });
  }
}
