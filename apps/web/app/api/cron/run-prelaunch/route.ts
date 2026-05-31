import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { logError, logInfo, messageOf } from "@/lib/log";
import { runPrelaunchOnce } from "@/lib/prelaunch-dispatcher";

export const runtime = "nodejs";

// Discovery + roast queue. Each pending row may hit token contract
// (eth_call) + 2 GitHub search calls + repo metadata reads. Budget gives the
// tick ample time without re-arming itself.
export const maxDuration = 120;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireCronAuth(req, {
    missingEvent: "run_prelaunch_cron.misconfigured",
    unauthorizedEvent: "run_prelaunch_cron.unauthorized",
  });
  if (auth !== null) return auth;

  const t0 = Date.now();
  try {
    const result = await runPrelaunchOnce();
    const elapsedMs = Date.now() - t0;
    logInfo("run_prelaunch_cron.complete", { ...result, elapsedMs });
    return NextResponse.json({ ...result, elapsedMs });
  } catch (err) {
    logError("run_prelaunch_cron.failed", { message: messageOf(err) });
    return new NextResponse("prelaunch tick failed", { status: 500 });
  }
}
