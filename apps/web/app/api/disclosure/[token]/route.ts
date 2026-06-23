import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { acknowledgeDisclosure, requestDisclosurePublication } from "@/lib/disclosure";
import { isDisclosureGateEnabled } from "@/lib/daybreak-gates-env";
import { disclosureTokenLogId, verifyDisclosureToken } from "@/lib/disclosure-token";
import { logInfo, logWarn } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { token: string };

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<RouteParams> },
): Promise<NextResponse> {
  if (!isDisclosureGateEnabled()) {
    return new NextResponse("not found", { status: 404 });
  }
  const { token } = await params;
  const verified = verifyDisclosureToken(token);
  const logId = disclosureTokenLogId(token);
  if (verified.kind !== "ok") {
    logWarn("disclosure_action.token_invalid", { logId, kind: verified.kind });
    return new NextResponse("invalid disclosure link", { status: 400 });
  }

  const form = await req.formData();
  const action = String(form.get("action") ?? "");
  const rawComment = String(form.get("comment") ?? "")
    .trim()
    .slice(0, 2000);
  const comment = rawComment.length === 0 ? null : rawComment;
  const actorLabel = `disclosure-link:${logId}`;

  if (action === "acknowledge") {
    await acknowledgeDisclosure({
      findingId: verified.payload.findingId,
      actorLabel,
      comment,
    });
  } else if (action === "request-publication") {
    await requestDisclosurePublication({
      findingId: verified.payload.findingId,
      actorLabel,
      comment,
    });
  } else {
    return new NextResponse("unsupported action", { status: 400 });
  }

  logInfo("disclosure_action.accepted", {
    logId,
    action,
    findingId: verified.payload.findingId,
  });
  return new NextResponse(
    '<!doctype html><meta name="robots" content="noindex"><p>Recorded. AntFleet has been notified.</p>',
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    },
  );
}
