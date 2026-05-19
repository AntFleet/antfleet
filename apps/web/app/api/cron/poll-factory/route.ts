import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { logError, logInfo, logWarn, messageOf } from "@/lib/log";
import { pollFactoryOnce } from "@/scripts/poll-factory";

export const runtime = "nodejs";

// One tick = a single Base eth_getLogs sweep (bounded by 2000-block chunks)
// plus per-event eth_getBlock fetches. Cold cursor → may scan ≥ 4000 blocks.
// 60s is plenty for the expected (≤ 5 events / 5 minutes) cadence.
export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env["CRON_SECRET"];
  if (secret === undefined || secret.length === 0) {
    logError("poll_factory_cron.misconfigured", { reason: "CRON_SECRET missing" });
    return new NextResponse("server misconfigured", { status: 500 });
  }
  const authHeader = req.headers.get("authorization");
  const expected = `Bearer ${secret}`;
  const provided = authHeader ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    logWarn("poll_factory_cron.unauthorized", { hasAuth: authHeader !== null });
    return new NextResponse("unauthorized", { status: 401 });
  }

  const t0 = Date.now();
  try {
    const result = await pollFactoryOnce();
    const elapsedMs = Date.now() - t0;
    logInfo("poll_factory_cron.complete", {
      scanned: result.scanned,
      inserted: result.inserted,
      toBlock: result.toBlock.toString(),
      elapsedMs,
    });
    return NextResponse.json({
      scanned: result.scanned,
      inserted: result.inserted,
      toBlock: result.toBlock.toString(),
      elapsedMs,
    });
  } catch (err) {
    logError("poll_factory_cron.failed", { message: messageOf(err) });
    return new NextResponse("poll factory tick failed", { status: 500 });
  }
}
