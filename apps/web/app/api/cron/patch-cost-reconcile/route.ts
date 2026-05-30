import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { logError, logInfo, logWarn, messageOf } from "@/lib/log";
import { runPatchCostReconcile } from "@/lib/patch-cost-reconcile";

// node:crypto + DB driver are Node-only — lock this off Edge.
export const runtime = "nodejs";

// Weekly backfill: bounded by reviews-with-patch-activity in the last 30 days,
// a single-digit-to-low-hundreds row count. One UPDATE per candidate review.
export const maxDuration = 60;

// Patch Agent cost reconciliation — backfills reviews.cost_patch_usd for rows
// that predate the inline (Option A) instrumentation. Scheduled Monday 02:00
// UTC. Auth mirrors the canonical cron pattern: Vercel sets
// Authorization: Bearer <CRON_SECRET>; constant-time compare denies a
// length/prefix oracle to anything that reaches this route before the edge
// rate-limit (defense in depth).
export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env["CRON_SECRET"];
  if (secret === undefined || secret.length === 0) {
    logError("cron.misconfigured", {
      reason: "CRON_SECRET missing",
      route: "patch-cost-reconcile",
    });
    return new NextResponse("server misconfigured", { status: 500 });
  }
  const authHeader = req.headers.get("authorization");
  const expected = `Bearer ${secret}`;
  const provided = authHeader ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    logWarn("cron.unauthorized", { route: "patch-cost-reconcile", hasAuth: authHeader !== null });
    return new NextResponse("unauthorized", { status: 401 });
  }

  const t0 = Date.now();
  try {
    const summary = await runPatchCostReconcile();
    logInfo("cron.patch_cost_reconcile_complete", {
      ...summary,
      elapsedMs: Date.now() - t0,
    });
    return NextResponse.json(summary);
  } catch (err) {
    logError("cron.patch_cost_reconcile_failed", { message: messageOf(err) });
    return new NextResponse("patch cost reconcile failed", { status: 500 });
  }
}
