import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { logError, logInfo, logWarn, messageOf } from "@/lib/log";
import { runReviewRetryTick } from "@/lib/review-retry";

// node:crypto + DB driver are Node-only — lock this off Edge.
export const runtime = "nodejs";

// A single review can take up to ~90s and we process up to 10 per tick
// serially (review-retry.ts:RETRY_CONCURRENCY); 300s is the Pro plan
// ceiling and matches the webhook's maxDuration so the worker has the
// same headroom in both invocation paths.
export const maxDuration = 300;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env["CRON_SECRET"];
  if (secret === undefined || secret.length === 0) {
    logError("review_retry_cron.misconfigured", { reason: "CRON_SECRET missing" });
    return new NextResponse("server misconfigured", { status: 500 });
  }
  const authHeader = req.headers.get("authorization");
  const expected = `Bearer ${secret}`;
  const provided = authHeader ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    logWarn("review_retry_cron.unauthorized", { hasAuth: authHeader !== null });
    return new NextResponse("unauthorized", { status: 401 });
  }

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
    return new NextResponse("retry tick failed", { status: 500 });
  }
}
