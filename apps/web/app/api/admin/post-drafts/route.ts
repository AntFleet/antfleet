import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  loadPostDraftQueue,
  resolvePostDraft,
  POST_DRAFT_STATUSES,
  type PostDraftStatus,
} from "@/db/queries";
import type { PostDraft } from "@/db/schema";
import { logError, logInfo, logWarn, messageOf } from "@/lib/log";

// node:crypto + DB driver are Node-only — lock this off Edge.
export const runtime = "nodejs";

// Operator-only post-draft queue. NOT publicly documented — the operator
// drains event-generated drafts (see lib/post-drafts.ts) via curl or
// scripts/post-queue.ts. Auth: OPERATOR_SECRET only; cron credentials must
// never authorize operator-only state changes. Nothing here posts to X:
// each draft carries a prefilled x.com intent URL, and the human click IS
// the approval.
export type PostDraftsDeps = {
  // Resolved server secret. Undefined/empty means the server is
  // misconfigured → 500, never an auth bypass.
  secret: string | undefined;
  list: (status: PostDraftStatus) => Promise<PostDraft[]>;
  resolve: (id: string, action: "posted" | "dismissed") => Promise<boolean>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function unauthorized(req: NextRequest, secret: string | undefined): NextResponse | null {
  if (secret === undefined || secret.length === 0) {
    logError("admin.post_drafts_misconfigured", { reason: "OPERATOR_SECRET missing" });
    return new NextResponse("server misconfigured", { status: 500 });
  }
  const authHeader = req.headers.get("authorization");
  const expected = `Bearer ${secret}`;
  const provided = authHeader ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    logWarn("admin.post_drafts_unauthorized", { hasAuth: authHeader !== null });
    return new NextResponse("unauthorized", { status: 401 });
  }
  return null;
}

// Prefilled tweet composer URL — same shape as components/TweetIntent.tsx.
// Draft bodies carry their permalink inline, so text + via is the whole post.
function intentUrl(body: string): string {
  const params = new URLSearchParams({ text: body, via: "AntFleetDev" });
  return `https://x.com/intent/tweet?${params.toString()}`;
}

function isPostDraftStatus(value: string): value is PostDraftStatus {
  return (POST_DRAFT_STATUSES as readonly string[]).includes(value);
}

export async function handleListPostDrafts(
  req: NextRequest,
  deps: PostDraftsDeps,
): Promise<NextResponse> {
  const denied = unauthorized(req, deps.secret);
  if (denied !== null) return denied;

  const statusParam = req.nextUrl.searchParams.get("status") ?? "draft";
  if (!isPostDraftStatus(statusParam)) {
    return new NextResponse("invalid status", { status: 400 });
  }

  try {
    const rows = await deps.list(statusParam);
    return NextResponse.json({
      status: statusParam,
      count: rows.length,
      drafts: rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        body: row.body,
        source: row.source,
        createdAt: row.createdAt,
        intentUrl: intentUrl(row.body),
      })),
    });
  } catch (err) {
    logError("admin.post_drafts_list_failed", { message: messageOf(err) });
    return new NextResponse("list failed", { status: 500 });
  }
}

type ResolveBody = { id: string; action: "posted" | "dismissed" };

// Parse + validate the POST body. Returns null on any malformed input → 400.
function parseBody(raw: unknown): ResolveBody | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const id = obj["id"];
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  const action = obj["action"];
  if (action !== "posted" && action !== "dismissed") return null;
  return { id, action };
}

export async function handleResolvePostDraft(
  req: NextRequest,
  deps: PostDraftsDeps,
): Promise<NextResponse> {
  const denied = unauthorized(req, deps.secret);
  if (denied !== null) return denied;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return new NextResponse("invalid JSON body", { status: 400 });
  }
  const body = parseBody(rawBody);
  if (body === null) {
    return new NextResponse("id (uuid) and action (posted|dismissed) are required", {
      status: 400,
    });
  }

  try {
    const resolved = await deps.resolve(body.id, body.action);
    if (!resolved) {
      // Unknown id, or the draft was already resolved — the operator should
      // re-list rather than assume success.
      return new NextResponse("draft not found or already resolved", { status: 404 });
    }
    logInfo("admin.post_draft_resolved", { id: body.id, action: body.action });
    return NextResponse.json({ resolved: true, id: body.id, action: body.action });
  } catch (err) {
    logError("admin.post_drafts_resolve_failed", { id: body.id, message: messageOf(err) });
    return new NextResponse("resolve failed", { status: 500 });
  }
}

function envDeps(): PostDraftsDeps {
  return {
    secret: process.env["OPERATOR_SECRET"],
    list: loadPostDraftQueue,
    resolve: resolvePostDraft,
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handleListPostDrafts(req, envDeps());
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handleResolvePostDraft(req, envDeps());
}
