import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { logError, logInfo, messageOf } from "@/lib/log";
import { scanDepositsOnce } from "@/scripts/scan-deposits";

export const runtime = "nodejs";
// Tick scans up to 2000 blocks per chunk of USDC Transfer events filtered
// to the deposit address (single eth_getLogs call) + one DB roundtrip per
// matched log. Expected steady-state load is single-digit Transfers/min, so
// even a cold-start cursor (5M blocks back) completes in well under 60s
// after the first few minutes of catch-up.
export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireCronAuth(req, {
    missingEvent: "scan_deposits_cron.misconfigured",
    unauthorizedEvent: "scan_deposits_cron.unauthorized",
    hasAuthMode: "nonempty",
  });
  if (auth !== null) return auth;

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
