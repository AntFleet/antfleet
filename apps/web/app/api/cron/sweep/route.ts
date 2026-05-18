import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { logError, logInfo, logWarn, messageOf } from "@/lib/log";
import { runDailyOnboarderCheckIns } from "@/lib/onboarder";
import { runOutgoingPrsPoll } from "@/lib/outgoing-prs";
import { runSweep } from "@/lib/sweep";

// node:crypto + DB driver are Node-only — lock this off Edge.
export const runtime = "nodejs";

// Sweeper iterates every open finding sequentially against the GitHub
// API — historically fast enough under the 60s Hobby ceiling. Onboarder
// check-ins run on the same tick (slice O5); each candidate adds one
// Anthropic call (~30s) plus a GitHub post. Bumped to 180s (Pro plan
// has 300s headroom) so a single-digit-partner Phase 2 stays comfortable.
export const maxDuration = 180;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env["CRON_SECRET"];
  if (secret === undefined || secret.length === 0) {
    logError("cron.misconfigured", { reason: "CRON_SECRET missing" });
    return new NextResponse("server misconfigured", { status: 500 });
  }
  const authHeader = req.headers.get("authorization");
  // Vercel's cron invocation sets Authorization: Bearer <CRON_SECRET>.
  // Constant-time compare to deny a length / prefix oracle to anything that
  // can reach this route before Vercel's edge rate-limit (defense in depth).
  const expected = `Bearer ${secret}`;
  const provided = authHeader ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
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
      const message = messageOf(err);
      logError("cron.onboarder_checkins_failed", { message });
    }

    // Cross-repo receipts — poll the merge state of outgoing PRs that
    // antfleet-ops opened on third-party repos. Wraps its own try/catch
    // internally (runOutgoingPrsPoll returns null on failure) so it can
    // never destabilize the cron tick. Skipped silently in environments
    // without ANTFLEET_OPS_GH_TOKEN — the lazy token read inside
    // realPollDeps throws and is converted to a log line.
    const tOutgoing = Date.now();
    const outgoingResult = await runOutgoingPrsPoll();
    if (outgoingResult !== null) {
      logInfo("cron.outgoing_prs_poll_complete", {
        ...outgoingResult,
        elapsedMs: Date.now() - tOutgoing,
      });
    }

    const elapsedMs = Date.now() - t0;
    return NextResponse.json({
      ...result,
      onboarder: onboarderResult,
      outgoingPrs: outgoingResult,
      elapsedMs,
    });
  } catch (err) {
    const message = messageOf(err);
    logError("cron.sweep_failed", { message });
    return new NextResponse("sweep failed", { status: 500 });
  }
}
