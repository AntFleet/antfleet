import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { logError, logInfo, logWarn, messageOf } from "@/lib/log";
import { runPrelaunchOnce } from "@/lib/prelaunch-dispatcher";

export const runtime = "nodejs";

// Discovery + roast queue. Each pending row may hit token contract
// (eth_call) + 2 GitHub search calls + repo metadata reads. Budget gives the
// tick ample time without re-arming itself.
export const maxDuration = 120;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env["CRON_SECRET"];
  if (secret === undefined || secret.length === 0) {
    logError("run_prelaunch_cron.misconfigured", { reason: "CRON_SECRET missing" });
    return new NextResponse("server misconfigured", { status: 500 });
  }
  const authHeader = req.headers.get("authorization");
  const expected = `Bearer ${secret}`;
  const provided = authHeader ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    logWarn("run_prelaunch_cron.unauthorized", { hasAuth: authHeader !== null });
    return new NextResponse("unauthorized", { status: 401 });
  }

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
