import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { logError, logInfo, logWarn, messageOf } from "@/lib/log";
import { runOneRoast } from "@/lib/roast-runner";

export const runtime = "nodejs";

// One roast run = ~30 source-file fetches + two parallel LLM reviews. Bounded
// by review-pipeline's own timeouts. 300s is the Pro plan ceiling and matches
// the review-retry cron.
export const maxDuration = 300;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env["CRON_SECRET"];
  if (secret === undefined || secret.length === 0) {
    logError("roast_cron.misconfigured", { reason: "CRON_SECRET missing" });
    return new NextResponse("server misconfigured", { status: 500 });
  }
  const authHeader = req.headers.get("authorization");
  const expected = `Bearer ${secret}`;
  const provided = authHeader ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    logWarn("roast_cron.unauthorized", { hasAuth: authHeader !== null });
    return new NextResponse("unauthorized", { status: 401 });
  }

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
