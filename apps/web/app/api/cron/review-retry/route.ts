import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { alertCritical } from "@/lib/alert";
import { requireCronAuth } from "@/lib/cron-auth";
import { logError, logInfo, messageOf } from "@/lib/log";
import { runReviewRetryTick } from "@/lib/review-retry";

// node:crypto + DB driver are Node-only — lock this off Edge.
export const runtime = "nodejs";

// A single review can take up to ~90s and we process up to 10 per tick
// serially (review-retry.ts:RETRY_CONCURRENCY); 300s is the Pro plan
// ceiling and matches the webhook's maxDuration so the worker has the
// same headroom in both invocation paths.
export const maxDuration = 300;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireCronAuth(req, {
    missingEvent: "review_retry_cron.misconfigured",
    unauthorizedEvent: "review_retry_cron.unauthorized",
  });
  if (auth !== null) return auth;

  const t0 = Date.now();
  try {
    const result = await runReviewRetryTick();
    const elapsedMs = Date.now() - t0;
    logInfo("review_retry_cron.complete", {
      ...result,
      elapsedMs,
    });
    return NextResponse.json({ ...result, elapsedMs });
  } catch (err) {
    const message = messageOf(err);
    logError("review_retry_cron.failed", { message });
    alertCritical("review_retry_cron.failed", { message });
    return new NextResponse("retry tick failed", { status: 500 });
  }
}
