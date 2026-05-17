import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/index";

// Liveness + readiness probe. Vercel does its own platform-level health
// monitoring; this gives us application-level signal — Postgres connectivity
// and presence of every secret the runtime path depends on. Useful for
// external uptime monitors (Pingdom, BetterStack, etc.) and for confirming
// a fresh deploy is wired up before pointing real traffic at it.
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

type DbCheck = { ok: boolean; latencyMs?: number; error?: string };
type EnvCheck = { ok: boolean; missing: string[] };
type HealthStatus = {
  ok: boolean;
  ts: string;
  checks: { db: DbCheck; env: EnvCheck };
};

export async function GET(): Promise<NextResponse<HealthStatus>> {
  const ts = new Date().toISOString();

  const missing = REQUIRED_ENV.filter(
    (name) => process.env[name] === undefined || process.env[name] === "",
  );
  const env: EnvCheck = { ok: missing.length === 0, missing };

  const dbStart = Date.now();
  let dbCheck: DbCheck;
  try {
    await db.execute(sql`select 1`);
    dbCheck = { ok: true, latencyMs: Date.now() - dbStart };
  } catch (err) {
    dbCheck = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const ok = env.ok && dbCheck.ok;
  return NextResponse.json(
    { ok, ts, checks: { db: dbCheck, env } },
    { status: ok ? 200 : 503 },
  );
}
