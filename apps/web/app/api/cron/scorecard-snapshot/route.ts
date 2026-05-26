import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { logError, logInfo, logWarn } from "@/lib/log";
import { insertScorecardSnapshot } from "@/db/queries";
import {
  computeScorecardForWeek,
  weekEndingSunday,
  GENERATOR_VERSION,
} from "@/lib/scorecard";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env["CRON_SECRET"];
  if (secret === undefined || secret.length === 0) {
    logError("cron.misconfigured", { reason: "CRON_SECRET missing" });
    return new NextResponse("server misconfigured", { status: 500 });
  }
  const authHeader = req.headers.get("authorization");
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
