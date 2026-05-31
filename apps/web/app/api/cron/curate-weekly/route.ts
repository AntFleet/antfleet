import { Pool } from "@neondatabase/serverless";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { curateWeekly } from "@/lib/curate-weekly";
import { logError, logInfo, messageOf } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireCronAuth(req, {
    missingEvent: "curate_weekly_cron.misconfigured",
    unauthorizedEvent: "curate_weekly_cron.unauthorized",
  });
  if (auth !== null) return auth;

  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    logError("curate_weekly_cron.misconfigured", { reason: "DATABASE_URL missing" });
    return new NextResponse("server misconfigured", { status: 500 });
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const t0 = Date.now();
  try {
    const result = await curateWeekly({ pool, apply: true });
    const elapsedMs = Date.now() - t0;
    logInfo("curate_weekly_cron.complete", { ...result, elapsedMs });
    return NextResponse.json({ ...result, elapsedMs });
  } catch (err) {
    const message = messageOf(err);
    logError("curate_weekly_cron.failed", { message });
    return NextResponse.json({ message }, { status: 500 });
  } finally {
    await pool.end();
  }
}
