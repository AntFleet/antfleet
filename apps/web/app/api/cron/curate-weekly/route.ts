import { timingSafeEqual } from "node:crypto";
import { Pool } from "@neondatabase/serverless";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { curateWeekly } from "@/lib/curate-weekly";
import { logError, logInfo, logWarn, messageOf } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env["CRON_SECRET"];
  if (secret === undefined || secret.length === 0) {
    logError("curate_weekly_cron.misconfigured", { reason: "CRON_SECRET missing" });
    return new NextResponse("server misconfigured", { status: 500 });
  }
  const authHeader = req.headers.get("authorization");
  const expected = `Bearer ${secret}`;
  const provided = authHeader ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    logWarn("curate_weekly_cron.unauthorized", { hasAuth: authHeader !== null });
    return new NextResponse("unauthorized", { status: 401 });
  }

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
