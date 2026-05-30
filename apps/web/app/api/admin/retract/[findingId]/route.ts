import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { retractFinding } from "@/db/queries";
import { logError, logInfo, logWarn, messageOf } from "@/lib/log";

// node:crypto + DB driver are Node-only — lock this off Edge.
export const runtime = "nodejs";

// Operator-only retraction endpoint. NOT publicly documented — the operator
// hits it via curl when a maintainer's correction request (to
// privacy@antfleet.dev) is upheld. Auth: OPERATOR_SECRET if set, else
// CRON_SECRET (the operator already holds it). Constant-time bearer compare,
// same pattern as the cron routes.
export type RetractDeps = {
  // Resolved server secret (OPERATOR_SECRET ?? CRON_SECRET). Undefined/empty
  // means the server is misconfigured → 500, never an auth bypass.
  secret: string | undefined;
  // Returns false when the finding id is unknown or already retracted → 404.
  retract: (findingId: string, reason: string, requestorEmail: string | null) => Promise<boolean>;
};

type RetractBody = { reason: string; requestorEmail: string | null };

// Parse + validate the POST body. reason is required and non-empty;
// requestorEmail is optional. Returns null on any malformed input → 400.
function parseBody(raw: unknown): RetractBody | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const reason = obj["reason"];
  if (typeof reason !== "string" || reason.trim().length === 0) return null;
  const email = obj["requestorEmail"];
  const requestorEmail = typeof email === "string" && email.trim().length > 0 ? email.trim() : null;
  return { reason: reason.trim(), requestorEmail };
}

export async function handleRetract(
  req: NextRequest,
  findingId: string,
  deps: RetractDeps,
): Promise<NextResponse> {
  if (deps.secret === undefined || deps.secret.length === 0) {
    logError("admin.retract_misconfigured", { reason: "OPERATOR_SECRET/CRON_SECRET missing" });
    return new NextResponse("server misconfigured", { status: 500 });
  }
  const authHeader = req.headers.get("authorization");
  const expected = `Bearer ${deps.secret}`;
  const provided = authHeader ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    logWarn("admin.retract_unauthorized", { findingId, hasAuth: authHeader !== null });
    return new NextResponse("unauthorized", { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return new NextResponse("invalid JSON body", { status: 400 });
  }
  const body = parseBody(rawBody);
  if (body === null) {
    return new NextResponse("reason is required", { status: 400 });
  }

  try {
    const retracted = await deps.retract(findingId, body.reason, body.requestorEmail);
    if (!retracted) {
      // Unknown finding id, or already retracted — either way the operator
      // should look again rather than assume success.
      return new NextResponse("finding not found or already retracted", { status: 404 });
    }
    logInfo("admin.retract_succeeded", {
      findingId,
      hasRequestorEmail: body.requestorEmail !== null,
    });
    return NextResponse.json({ retracted: true, findingId });
  } catch (err) {
    logError("admin.retract_failed", { findingId, message: messageOf(err) });
    return new NextResponse("retraction failed", { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ findingId: string }> },
): Promise<NextResponse> {
  const { findingId } = await params;
  const secret = process.env["OPERATOR_SECRET"] ?? process.env["CRON_SECRET"];
  return handleRetract(req, findingId, { secret, retract: retractFinding });
}
