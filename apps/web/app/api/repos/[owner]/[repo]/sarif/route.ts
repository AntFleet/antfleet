import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ingestSarif } from "@/lib/sarif-ingest-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { owner: string; repo: string };

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<RouteParams> },
): Promise<NextResponse> {
  const { owner, repo } = await params;
  try {
    const body = (await req.json()) as unknown;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return json(400, { error: "invalid_body" });
    }
    const record = body as Record<string, unknown>;
    const sarifText = await sarifTextFrom(record);
    const sourceKind = typeof record["url"] === "string" ? "url" : "upload";
    const digest = createHash("sha256").update(sarifText).digest("hex");
    const result = await ingestSarif({
      owner,
      repo,
      installationId:
        typeof record["installationId"] === "number" ? record["installationId"] : null,
      sarifText,
      sourceKind,
      sourceUrl: typeof record["url"] === "string" ? record["url"] : null,
      fileBlobRef: `sha256:${digest}`,
      repoUrl: typeof record["repoUrl"] === "string" ? record["repoUrl"] : null,
      sha: typeof record["sha"] === "string" ? record["sha"] : null,
    });
    return json(202, {
      batch_id: result.batchId,
      source_tool: result.parsed.sourceToolName,
      stats: result.stats,
    });
  } catch (err) {
    return json(400, { error: "sarif_ingest_failed", message: messageOf(err) });
  }
}

async function sarifTextFrom(record: Record<string, unknown>): Promise<string> {
  if (typeof record["sarif"] === "string" && record["sarif"].length > 0) return record["sarif"];
  if (typeof record["url"] !== "string" || record["url"].length === 0) {
    throw new Error("provide sarif text or url");
  }
  const url = new URL(record["url"]);
  if (url.protocol !== "https:") throw new Error("SARIF URL must be https");
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`SARIF URL returned ${res.status}`);
  const text = await res.text();
  if (text.length > 10 * 1024 * 1024) throw new Error("SARIF file exceeds 10MB limit");
  return text;
}

function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
