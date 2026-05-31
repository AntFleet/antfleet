import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { logError, logInfo, messageOf } from "@/lib/log";
import { runPatchCostReconcile } from "@/lib/patch-cost-reconcile";

// node:crypto + DB driver are Node-only — lock this off Edge.
export const runtime = "nodejs";

// Weekly backfill: bounded by reviews-with-patch-activity in the last 30 days,
// a single-digit-to-low-hundreds row count. One UPDATE per candidate review.
export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireCronAuth(req, {
    missingEvent: "cron.misconfigured",
    unauthorizedEvent: "cron.unauthorized",
    missingFields: { route: "patch-cost-reconcile" },
    unauthorizedFields: { route: "patch-cost-reconcile" },
  });
  if (auth !== null) return auth;

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
