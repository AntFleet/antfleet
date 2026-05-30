import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { logError, logInfo, logWarn, messageOf } from "@/lib/log";
import { runRegressionFixtures, type RegressionResult } from "@/lib/regression-fixtures-cron";

// node:crypto + provider SDKs are Node-only — lock this off Edge.
export const runtime = "nodejs";

// Each fixture is 2 LLM calls (one per provider); the suite runs in parallel,
// so wall-clock is ~one review (the slowest provider call) rather than N
// sequential reviews. Both provider clients now cap a single call at 240s
// (Anthropic + OpenAI, matched), so the happy path sits well under 300s. Note
// the worst case is still unbounded by 300s — 240s x maxRetries(3) per a flaky
// provider can exceed the ceiling and Vercel will kill the function with a 500
// (a non-drift timeout, distinguishable by the log event; see below). Cost:
// ~2 calls x fixtures, once per week — a dozen calls every seven days.
export const maxDuration = 300;

// Drift detector: run the known-safe fixtures through the real two-model gate.
// The gate must NEVER fire on them; if it does, a silent provider model update
// has changed review behavior.
//
// A 500 from this route has THREE distinct meanings, disambiguated by the log
// (Vercel cron alerting pages on the 5xx status alone, so the status can't
// carry the distinction — the log event does):
//   - misconfigured  -> logError "cron.misconfigured"                (CRON_SECRET missing)
//   - run crashed    -> logError "cron.regression_fixtures_failed"   (provider hung/threw)
//   - DRIFT detected -> logError "regression_fixtures.unanimous_gate_fired" (the real signal)
// Only the last is the alarm this suite exists to raise; the response body on
// drift is JSON with `failures`, the other two are plain text. 200 + JSON
// summary when all fixtures pass.
export type RegressionDeps = {
  secret: string | undefined;
  run: () => Promise<RegressionResult>;
};

export async function handleRegressionFixtures(
  req: NextRequest,
  deps: RegressionDeps,
): Promise<NextResponse> {
  if (deps.secret === undefined || deps.secret.length === 0) {
    logError("cron.misconfigured", { reason: "CRON_SECRET missing", route: "regression-fixtures" });
    return new NextResponse("server misconfigured", { status: 500 });
  }
  const authHeader = req.headers.get("authorization");
  const expected = `Bearer ${deps.secret}`;
  const provided = authHeader ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    logWarn("cron.unauthorized", { route: "regression-fixtures", hasAuth: authHeader !== null });
    return new NextResponse("unauthorized", { status: 401 });
  }

  const t0 = Date.now();
  let result: RegressionResult;
  try {
    result = await deps.run();
  } catch (err) {
    logError("cron.regression_fixtures_failed", { message: messageOf(err) });
    return new NextResponse("regression fixtures run failed", { status: 500 });
  }

  const elapsedMs = Date.now() - t0;
  if (result.degraded > 0) {
    // A provider outage made some fixtures inconclusive — surface it, but it is
    // not a gate-drift regression on its own.
    logWarn("cron.regression_fixtures_degraded", {
      degradedFixtures: result.degradedFixtures,
      elapsedMs,
    });
  }
  if (result.failed > 0) {
    logError("regression_fixtures.unanimous_gate_fired", {
      failures: result.failures,
      details: result.details,
      elapsedMs,
    });
    return NextResponse.json(result, { status: 500 });
  }
  logInfo("cron.regression_fixtures_complete", { ...result, elapsedMs });
  return NextResponse.json(result);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handleRegressionFixtures(req, {
    secret: process.env["CRON_SECRET"],
    run: () => runRegressionFixtures(),
  });
}
