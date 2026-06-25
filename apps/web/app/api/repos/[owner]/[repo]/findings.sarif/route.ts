import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { loadPublicSarifFindingsForRepo } from "@/db/queries";
import { isCyberTierRepo } from "@/lib/cyber-tier";
import { isSarifExportEnabled } from "@/lib/daybreak-gates-env";
import { findingsToSarif, validateSarifForGithub } from "@/lib/sarif-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { owner: string; repo: string };

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<RouteParams> },
): Promise<NextResponse> {
  if (!isSarifExportEnabled()) {
    return NextResponse.json(
      { error: "sarif_export_disabled" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  const { owner, repo } = await params;
  // Cyber-tier repos are excluded from the public SARIF export entirely
  // (not "empty SARIF" — 404, to avoid confirming the repo's existence
  // as a tracked target). When ANTFLEET_CYBER_TIER is OFF this check
  // always returns false, so behavior is byte-identical to pre-cyber-tier.
  if (await isCyberTierRepo(owner, repo)) {
    return NextResponse.json(
      { error: "sarif_export_disabled" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  const rows = await loadPublicSarifFindingsForRepo({ owner, repo });
  const baseUrl = req.nextUrl.origin === "null" ? undefined : req.nextUrl.origin;
  const sarif = findingsToSarif({ owner, repo, findings: rows, baseUrl });
  const validationErrors = validateSarifForGithub(sarif);
  if (validationErrors.length > 0) {
    return NextResponse.json(
      { error: "invalid_sarif_export", validation_errors: validationErrors },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
  return new NextResponse(JSON.stringify(sarif, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/sarif+json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
