import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/index";

// Liveness + readiness probe. Vercel does its own platform-level health
// monitoring; this gives us application-level signal — Postgres connectivity
// and presence of every secret the runtime path depends on. Useful for
// external uptime monitors (Pingdom, BetterStack, etc.) and for confirming
// a fresh deploy is wired up before pointing real traffic at it.
//
// Response is intentionally minimal — `{ ok }` only. Per the AntFleet review
// on PR #3, leaking names of missing env vars or raw DB error strings to
// unauthenticated callers is unnecessary info disclosure. Detailed diagnostic
// information stays in server-side logs where the on-call can read it.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every env var the webhook handler + cron sweep + review pipeline read
// from process.env. If any of these are missing in production, the next
// real request will fail — the health endpoint catches that pre-emptively.
const REQUIRED_ENV: readonly string[] = [
  "DATABASE_URL",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_WEBHOOK_SECRET",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CRON_SECRET",
];

export async function GET(): Promise<NextResponse<{ ok: boolean }>> {
  const missing = REQUIRED_ENV.filter(
    (name) => process.env[name] === undefined || process.env[name] === "",
  );
  const envOk = missing.length === 0;

  let dbOk = false;
  let dbError: unknown = null;
  try {
    await db.execute(sql`select 1`);
    dbOk = true;
  } catch (err) {
    dbError = err;
  }

  const ok = envOk && dbOk;

  // Detailed diagnostics go to server logs only — not to the response body.
  if (!ok) {
    console.warn(
      JSON.stringify({
        event: "health.degraded",
        envOk,
        missingCount: missing.length,
        missing,
        dbOk,
        dbError: dbError instanceof Error ? dbError.message : null,
      }),
    );
  }

  return NextResponse.json({ ok }, { status: ok ? 200 : 503 });
}
