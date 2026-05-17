import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { logError, logInfo, logWarn } from "@/lib/log";
import { runDailyOnboarderCheckIns } from "@/lib/onboarder";
import { runSweep } from "@/lib/sweep";

// node:crypto + DB driver are Node-only — lock this off Edge.
export const runtime = "nodejs";

// The sweep iterates every open finding sequentially against the GitHub API.
// Hobby plan ceiling is 60s; that's roughly enough for ~30 reviews in v1
// (one git.getRef + one compareCommits + one listForIssueComment per
// review). Revisit on Pro when real-repo volume grows.
export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env["CRON_SECRET"];
  if (secret === undefined || secret.length === 0) {
    logError("cron.misconfigured", { reason: "CRON_SECRET missing" });
    return new NextResponse("server misconfigured", { status: 500 });
  }
  const authHeader = req.headers.get("authorization");
  // Vercel's cron invocation sets Authorization: Bearer <CRON_SECRET>.
  // Plain string equality is fine here — both sides are server-controlled
  // and the cost of constant-time comparison is invisible at cron cadence.
  if (authHeader !== `Bearer ${secret}`) {
    logWarn("cron.unauthorized", { hasAuth: authHeader !== null });
    return new NextResponse("unauthorized", { status: 401 });
  }

  const t0 = Date.now();
  try {
    const result = await runSweep();
    const sweepMs = Date.now() - t0;
    logInfo("cron.sweep_complete", {
      swept: result.swept,
      closed: result.closed,
      reactionsRecorded: result.reactionsRecorded,
      reviewsSkipped: result.reviewsSkipped,
      errorCount: result.errors.length,
      elapsedMs: sweepMs,
    });

    // Onboarder daily check-in runs on the same cron tick as Sweeper.
    // Self-gates on ONBOARDER_ENABLED so prod stays silent until flipped.
    // Failure here is logged but does not 5xx the cron — Sweeper success
    // is the primary load-bearing outcome of this tick.
    const tOnboarder = Date.now();
    let onboarderResult: Awaited<ReturnType<typeof runDailyOnboarderCheckIns>> = {
      attempted: 0,
      posted: 0,
      skipped: 0,
      errors: 0,
    };
    try {
      onboarderResult = await runDailyOnboarderCheckIns(new Date());
      logInfo("cron.onboarder_checkins_complete", {
        ...onboarderResult,
        elapsedMs: Date.now() - tOnboarder,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError("cron.onboarder_checkins_failed", { message });
    }

    const elapsedMs = Date.now() - t0;
    return NextResponse.json({
      ...result,
      onboarder: onboarderResult,
      elapsedMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("cron.sweep_failed", { message });
    return new NextResponse("sweep failed", { status: 500 });
  }
}
