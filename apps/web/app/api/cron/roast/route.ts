import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { logError, logInfo, messageOf } from "@/lib/log";
import { runOneRoast } from "@/lib/roast-runner";

export const runtime = "nodejs";

// One roast run = ~30 source-file fetches + two parallel LLM reviews. Bounded
// by review-pipeline's own timeouts. 300s is the Pro plan ceiling and matches
// the review-retry cron.
export const maxDuration = 300;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireCronAuth(req, {
    missingEvent: "roast_cron.misconfigured",
    unauthorizedEvent: "roast_cron.unauthorized",
  });
  if (auth !== null) return auth;

  const t0 = Date.now();
  try {
    const result = await runOneRoast();
    const elapsedMs = Date.now() - t0;
    logInfo("roast_cron.complete", { ...result, elapsedMs });
    return NextResponse.json({ ...result, elapsedMs });
  } catch (err) {
    logError("roast_cron.failed", { message: messageOf(err) });
    return new NextResponse("roast tick failed", { status: 500 });
  }
}
