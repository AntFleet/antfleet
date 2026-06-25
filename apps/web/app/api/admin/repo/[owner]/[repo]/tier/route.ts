import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  loadRepoTierChangeLog,
  readRepoCyberTierIgnoringFlag,
  REASON_MAX_CHARS,
  REASON_MIN_CHARS,
  setRepoCyberTier,
} from "@/lib/cyber-tier-admin";
import type { CyberTier } from "@/db/schema";
import { logError, logInfo, logWarn, messageOf } from "@/lib/log";

// Node-only — timingSafeEqual + DB driver are not Edge-safe.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Operator-only API for the repo cyber tier (Daybreak follow-up).
// Bearer-gated via OPERATOR_SECRET (matches /api/admin/disclosure/... and
// /api/admin/retract). No cookie-session UI; the operator hits this via
// curl after authenticating to the host environment.
//
// Routes:
//   GET  /api/admin/repo/{owner}/{repo}/tier — returns current tier +
//        last 25 change-log rows. Reads the raw repo_tier row regardless
//        of the ANTFLEET_CYBER_TIER flag, so operators can inspect what's
//        stored even when the policy is dormant.
//   POST /api/admin/repo/{owner}/{repo}/tier — body { tier, reason }.
//        Writes the tier change atomically with one row in
//        repo_tier_change_log. Reason must be 10..2000 chars (enforced
//        both client-side here and via the SQL CHECK on the table).
//
// IMPORTANT: setRepoCyberTier is imported from lib/cyber-tier-admin.ts
// — the policy contract is that this file is the ONLY consumer outside
// tests. The grep-test in lib/cyber-tier-admin.test.ts asserts that.

type RouteParams = { owner: string; repo: string };

type SetTierBody = { tier: CyberTier; reason: string };

function parseBody(raw: unknown): SetTierBody | { error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "body must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  const tier = obj["tier"];
  if (tier !== "default" && tier !== "cyber") {
    return { error: "tier must be 'default' or 'cyber'" };
  }
  const reason = obj["reason"];
  if (typeof reason !== "string") {
    return { error: "reason must be a string" };
  }
  const trimmed = reason.trim();
  if (trimmed.length < REASON_MIN_CHARS) {
    return { error: `reason must be at least ${REASON_MIN_CHARS} characters` };
  }
  if (trimmed.length > REASON_MAX_CHARS) {
    return { error: `reason must be at most ${REASON_MAX_CHARS} characters` };
  }
  return { tier, reason: trimmed };
}

// Minimum reasonable length for an operator secret. 32 chars of base64
// (>= 192 bits of entropy) is the floor — anything shorter is treated as
// a misconfiguration, NOT a valid weak password. This prevents a typo
// like OPERATOR_SECRET="   " from authenticating an attacker's
// Authorization: Bearer "   " header. (security audit pass-1, medium.)
const MIN_OPERATOR_SECRET_LENGTH = 32;

function authorize(req: NextRequest): NextResponse | null {
  const raw = process.env["OPERATOR_SECRET"];
  const secret = raw === undefined ? "" : raw.trim();
  if (secret.length < MIN_OPERATOR_SECRET_LENGTH) {
    logError("admin.cyber_tier_misconfigured", {
      reason: "OPERATOR_SECRET missing or too short",
      minLength: MIN_OPERATOR_SECRET_LENGTH,
    });
    return new NextResponse("server misconfigured", { status: 500 });
  }
  const authHeader = req.headers.get("authorization");
  const expected = `Bearer ${secret}`;
  const provided = authHeader ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    logWarn("admin.cyber_tier_unauthorized", { hasAuth: authHeader !== null });
    return new NextResponse("unauthorized", { status: 401 });
  }
  return null;
}

function actorLabelFromHeaders(req: NextRequest): string {
  // Operators set the X-Actor header to mark which human / script made
  // the change. Falls back to a generic label so the audit row is never
  // null — the SQL column is NOT NULL.
  const raw = req.headers.get("x-actor");
  if (raw === null) return "operator";
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return "operator";
  return trimmed;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<RouteParams> },
): Promise<NextResponse> {
  const unauthorized = authorize(req);
  if (unauthorized !== null) return unauthorized;
  const { owner, repo } = await params;
  try {
    const [tier, log] = await Promise.all([
      readRepoCyberTierIgnoringFlag({ owner, repo }),
      loadRepoTierChangeLog({ owner, repo, limit: 25 }),
    ]);
    return NextResponse.json(
      {
        owner: owner.toLowerCase(),
        repo: repo.toLowerCase(),
        tier,
        changeLog: log,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    logError("admin.cyber_tier_get_failed", { owner, repo, message: messageOf(err) });
    return new NextResponse("read failed", { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<RouteParams> },
): Promise<NextResponse> {
  const unauthorized = authorize(req);
  if (unauthorized !== null) return unauthorized;
  const { owner, repo } = await params;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return new NextResponse("invalid JSON body", { status: 400 });
  }
  const parsed = parseBody(rawBody);
  if ("error" in parsed) {
    return new NextResponse(parsed.error, { status: 400 });
  }

  const actor = actorLabelFromHeaders(req);
  try {
    const result = await setRepoCyberTier({
      owner,
      repo,
      newTier: parsed.tier,
      reason: parsed.reason,
      actor,
    });
    if (!result.ok) {
      if (result.reason === "noop") {
        return NextResponse.json(
          { changed: false, reason: "noop", tier: parsed.tier },
          { status: 200 },
        );
      }
      return new NextResponse(result.reason, { status: 400 });
    }
    logInfo("admin.cyber_tier_set", {
      owner: owner.toLowerCase(),
      repo: repo.toLowerCase(),
      oldTier: result.oldTier,
      newTier: result.newTier,
      actor,
    });
    return NextResponse.json({
      changed: true,
      oldTier: result.oldTier,
      newTier: result.newTier,
    });
  } catch (err) {
    logError("admin.cyber_tier_set_failed", { owner, repo, message: messageOf(err) });
    return new NextResponse("set failed", { status: 500 });
  }
}
