import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { insertScorecardSnapshot } from "@/db/queries";
import { requireCronAuth } from "@/lib/cron-auth";
import { logError, logInfo } from "@/lib/log";
import { computeScorecardForWeek, weekEndingSunday, GENERATOR_VERSION } from "@/lib/scorecard";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireCronAuth(req, {
    missingEvent: "cron.misconfigured",
    unauthorizedEvent: "cron.unauthorized",
  });
  if (auth !== null) return auth;

  const t0 = Date.now();
  try {
    // Compute snapshot for the most-recently-ended week (last Sunday).
    // The cron fires Saturday 00:00 UTC, so "last Sunday" is 6 days ago.
    const now = new Date();
    const yyyyMmDd = weekEndingSunday(now);

    const weekEndDate = new Date(yyyyMmDd + "T00:00:00Z");
    const payload = await computeScorecardForWeek(weekEndDate);
    const inserted = await insertScorecardSnapshot(yyyyMmDd, payload, GENERATOR_VERSION);

    const elapsedMs = Date.now() - t0;

    if (!inserted) {
      logInfo("cron.scorecard_already_snapshotted", { yyyyMmDd, elapsedMs });
      return NextResponse.json({ status: "already-snapshotted", yyyyMmDd });
    }

    logInfo("cron.scorecard_snapshot_complete", {
      yyyyMmDd,
      reviewsAnalyzed: payload.sample.reviewsAnalyzed,
      findingsPosted: payload.sample.findingsPosted,
      elapsedMs,
    });

    return NextResponse.json({
      status: "ok",
      yyyyMmDd,
      reviewsAnalyzed: payload.sample.reviewsAnalyzed,
      findingsPosted: payload.sample.findingsPosted,
    });
  } catch (err) {
    logError("cron.scorecard_snapshot_failed", { error: String(err) });
    return new NextResponse("internal error", { status: 500 });
  }
}
