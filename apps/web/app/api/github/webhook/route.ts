import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { verifyGitHubSignature } from "@/lib/github-signature";
import { logError, logInfo, logWarn } from "@/lib/log";

// node:crypto is Node-only — lock this route off the Edge runtime.
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env["GITHUB_APP_WEBHOOK_SECRET"];
  if (secret === undefined || secret.length === 0) {
    logError("webhook.misconfigured", { reason: "GITHUB_APP_WEBHOOK_SECRET missing" });
    return new NextResponse("server misconfigured", { status: 500 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  const delivery = req.headers.get("x-github-delivery");
  const event = req.headers.get("x-github-event");

  if (!verifyGitHubSignature(rawBody, signature, secret)) {
    logWarn("webhook.signature_invalid", { delivery, event });
    return new NextResponse("invalid signature", { status: 401 });
  }

  let payload: { action?: unknown; installation?: { id?: unknown } } = {};
  try {
    payload = JSON.parse(rawBody) as typeof payload;
  } catch {
    logWarn("webhook.payload_unparseable", { delivery, event });
    return new NextResponse("invalid json", { status: 400 });
  }

  const action = typeof payload.action === "string" ? payload.action : null;
  const installationId =
    typeof payload.installation === "object" &&
    payload.installation !== null &&
    typeof payload.installation.id === "number"
      ? payload.installation.id
      : null;

  logInfo("webhook.received", { delivery, event, action, installationId });

  // Slice 3 will dispatch pull_request events to the review pipeline. For now,
  // verified deliveries are acknowledged so GitHub stops retrying.
  return NextResponse.json({ ok: true });
}
