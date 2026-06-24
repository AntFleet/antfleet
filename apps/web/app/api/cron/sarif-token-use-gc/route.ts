import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { purgeOldSarifIngestTokenUses } from "@/db/queries";
import { requireCronAuth } from "@/lib/cron-auth";
import { logError, logInfo, messageOf } from "@/lib/log";
import { runSarifTokenUseGc } from "@/lib/sarif-token-use-gc";

export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireCronAuth(req, {
    missingEvent: "sarif_token_use_gc_cron.misconfigured",
    unauthorizedEvent: "sarif_token_use_gc_cron.unauthorized",
  });
  if (auth !== null) return auth;

  const t0 = Date.now();
  try {
    const result = await runSarifTokenUseGc({
      purgeBefore: purgeOldSarifIngestTokenUses,
    });
    const elapsedMs = Date.now() - t0;
    logInfo("sarif_token_use_gc_cron.complete", {
      deleted: result.deleted,
      cutoff: result.cutoff.toISOString(),
      elapsedMs,
    });
    return NextResponse.json({
      deleted: result.deleted,
      cutoff: result.cutoff.toISOString(),
      elapsedMs,
    });
  } catch (err) {
    const message = messageOf(err);
    logError("sarif_token_use_gc_cron.failed", { message });
    return new NextResponse("sarif token use gc failed", { status: 500 });
  }
}
