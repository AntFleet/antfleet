import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { loadDisclosureMaintainerSecret, recordFindingDisclosureLog } from "@/db/queries";
import { decryptDisclosureSecret } from "@/lib/disclosure-token";
import { logError, logInfo, logWarn, messageOf } from "@/lib/log";

export const runtime = "nodejs";

export type MaintainerUrlExportDeps = {
  secret: string | undefined;
  loadSecret: typeof loadDisclosureMaintainerSecret;
  recordLog: typeof recordFindingDisclosureLog;
};

function authorized(req: NextRequest, secret: string | undefined): boolean | "misconfigured" {
  if (secret === undefined || secret.length === 0) return "misconfigured";
  const expected = `Bearer ${secret}`;
  const provided = req.headers.get("authorization") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function handleMaintainerUrlExport(
  req: NextRequest,
  findingId: string,
  deps: MaintainerUrlExportDeps,
): Promise<NextResponse> {
  const auth = authorized(req, deps.secret);
  if (auth === "misconfigured") {
    logError("admin.disclosure_url_export_misconfigured", { reason: "OPERATOR_SECRET missing" });
    return new NextResponse("server misconfigured", { status: 500 });
  }
  if (!auth) {
    logWarn("admin.disclosure_url_export_unauthorized", {
      findingId,
      hasAuth: req.headers.get("authorization") !== null,
    });
    return new NextResponse("unauthorized", { status: 401 });
  }

  try {
    const row = await deps.loadSecret(findingId);
    if (row === null) return new NextResponse("disclosure URL not found", { status: 404 });
    const maintainerUrl = decryptDisclosureSecret(row.maintainerUrlCiphertext);
    await deps.recordLog({
      findingId,
      fromState: row.state,
      toState: row.state,
      actorType: "operator",
      actorId: "admin.disclosure_url_export",
      reason: "operator exported maintainer disclosure URL",
      atSha: row.commitSha,
      metadata: { maintainerUrlLogId: row.maintainerUrlLogId },
    });
    logInfo("admin.disclosure_url_exported", {
      findingId,
      maintainerUrlLogId: row.maintainerUrlLogId,
    });
    return NextResponse.json({
      findingId,
      maintainerUrl,
      maintainerUrlLogId: row.maintainerUrlLogId,
    });
  } catch (err) {
    logError("admin.disclosure_url_export_failed", { findingId, message: messageOf(err) });
    return new NextResponse("disclosure URL export failed", { status: 500 });
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ findingId: string }> },
): Promise<NextResponse> {
  const { findingId } = await params;
  return handleMaintainerUrlExport(req, findingId, {
    secret: process.env["OPERATOR_SECRET"],
    loadSecret: loadDisclosureMaintainerSecret,
    recordLog: recordFindingDisclosureLog,
  });
}
