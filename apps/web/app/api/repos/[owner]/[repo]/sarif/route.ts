import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isInstallApprovedForRepo } from "@/db/queries";
import { isSarifIngestEnabledForInstall } from "@/lib/daybreak-gates-env";
import {
  ingestSarif,
  type SarifIngestDeps,
  type SarifIngestInput,
} from "@/lib/sarif-ingest-worker";
import { verifySarifIngestToken, type SarifIngestAuth } from "@/lib/sarif-auth-token";
import { MAX_SARIF_BYTES, SarifLimitError } from "@/lib/sarif-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { owner: string; repo: string };

export type SarifRouteDeps = {
  authenticate: (req: NextRequest) => SarifIngestAuth | "missing" | "invalid" | "misconfigured";
  enabled: SarifIngestDeps["enabled"];
  hasRepoAccess: (args: {
    installationId: number;
    owner: string;
    repo: string;
  }) => Promise<boolean>;
  ingest: (input: SarifIngestInput) => Promise<Awaited<ReturnType<typeof ingestSarif>>>;
};

const DEFAULT_DEPS: SarifRouteDeps = {
  authenticate: authenticateSarifRequest,
  enabled: isSarifIngestEnabledForInstall,
  hasRepoAccess: isInstallApprovedForRepo,
  ingest: (input) => ingestSarif(input),
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<RouteParams> },
): Promise<NextResponse> {
  return handleSarifIngest(req, { params }, DEFAULT_DEPS);
}

export async function handleSarifIngest(
  req: NextRequest,
  { params }: { params: Promise<RouteParams> },
  deps: SarifRouteDeps,
): Promise<NextResponse> {
  const { owner, repo } = await params;
  const auth = deps.authenticate(req);
  if (auth === "misconfigured") return json(500, { error: "server_misconfigured" });
  if (auth === "missing" || auth === "invalid") return json(401, { error: "unauthorized" });
  if (!(await deps.enabled(auth.installationId, repo))) {
    return json(403, { error: "sarif_ingest_disabled" });
  }
  if (auth.owner !== owner || auth.repo !== repo) {
    return json(403, { error: "repo_forbidden" });
  }
  const allowed = await deps.hasRepoAccess({ installationId: auth.installationId, owner, repo });
  if (!allowed) return json(403, { error: "repo_forbidden" });

  try {
    const body = await readJsonWithCap(req);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return json(400, { error: "invalid_body" });
    }
    const record = body as Record<string, unknown>;
    const sarifText = sarifTextFrom(record);
    if (Buffer.byteLength(sarifText, "utf8") > MAX_SARIF_BYTES) {
      throw new SarifLimitError("MAX_SARIF_BYTES", `SARIF text exceeds ${MAX_SARIF_BYTES} bytes`);
    }
    const digest = createHash("sha256").update(sarifText).digest("hex");
    const result = await deps.ingest({
      owner,
      repo,
      installationId: auth.installationId,
      sarifText,
      sourceKind: "upload",
      sourceUrl: null,
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
    if (err instanceof SarifLimitError) {
      return json(413, { error: "sarif_too_large", message: err.message });
    }
    return json(400, { error: "sarif_ingest_failed", message: messageOf(err) });
  }
}

function sarifTextFrom(record: Record<string, unknown>): string {
  if (typeof record["sarif"] === "string" && record["sarif"].length > 0) return record["sarif"];
  if (typeof record["url"] === "string" && record["url"].length > 0) {
    throw new Error("URL SARIF ingest is disabled; provide sarif text");
  }
  throw new Error("provide sarif text");
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

function authenticateSarifRequest(
  req: NextRequest,
): SarifIngestAuth | "missing" | "invalid" | "misconfigured" {
  const authHeader = req.headers.get("authorization");
  if (authHeader === null || !authHeader.startsWith("Bearer ")) return "missing";
  try {
    const result = verifySarifIngestToken(authHeader.slice("Bearer ".length));
    return result.kind === "ok" ? result.payload : "invalid";
  } catch {
    return "misconfigured";
  }
}

async function readJsonWithCap(req: NextRequest): Promise<unknown> {
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null) {
    const bytes = Number(contentLength);
    if (Number.isFinite(bytes) && bytes > MAX_SARIF_BYTES) {
      throw new SarifLimitError("MAX_SARIF_BYTES", `request body exceeds ${MAX_SARIF_BYTES} bytes`);
    }
  }
  const text = req.body === null ? "" : await readBodyStreamWithCap(req.body);
  return JSON.parse(text);
}

async function readBodyStreamWithCap(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > MAX_SARIF_BYTES) {
      throw new SarifLimitError("MAX_SARIF_BYTES", `request body exceeds ${MAX_SARIF_BYTES} bytes`);
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}
