import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { logError, logInfo, logWarn, messageOf } from "@/lib/log";
import { scanDepositsOnce } from "@/scripts/scan-deposits";

export const runtime = "nodejs";
// Tick scans up to 2000 blocks per chunk of USDC Transfer events filtered
// to the deposit address (single eth_getLogs call) + one DB roundtrip per
// matched log. Expected steady-state load is single-digit Transfers/min, so
// even a cold-start cursor (5M blocks back) completes in well under 60s
// after the first few minutes of catch-up.
export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env["CRON_SECRET"];
  if (secret === undefined || secret.length === 0) {
    logError("scan_deposits_cron.misconfigured", { reason: "CRON_SECRET missing" });
    return new NextResponse("server misconfigured", { status: 500 });
  }
  const authHeader = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    logWarn("scan_deposits_cron.unauthorized", { hasAuth: authHeader.length > 0 });
    return new NextResponse("unauthorized", { status: 401 });
  }

  const t0 = Date.now();
  try {
    const result = await scanDepositsOnce();
    const elapsedMs = Date.now() - t0;
    logInfo("scan_deposits_cron.complete", { ...result, elapsedMs });
    return NextResponse.json({ ...result, elapsedMs });
  } catch (err) {
    logError("scan_deposits_cron.failed", { message: messageOf(err) });
    return new NextResponse("scan-deposits tick failed", { status: 500 });
  }
}
