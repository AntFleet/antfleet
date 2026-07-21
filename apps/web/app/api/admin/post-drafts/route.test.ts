import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import type { PostDraft } from "@/db/schema";
import { handleListPostDrafts, handleResolvePostDraft, type PostDraftsDeps } from "./route";

const SECRET = "op-secret-value";
const DRAFT_ID = "0b7e4a52-9cb5-4c1e-8f66-8f1e2d3c4b5a";

function draftRow(over: Partial<PostDraft> = {}): PostDraft {
  return {
    id: DRAFT_ID,
    slug: "weekly-2026-w30-agent",
    title: "receipt of the week: agent",
    body: "receipt of the week\nantfleet.dev/agents/0xabc",
    source: "weekly",
    status: "draft",
    createdAt: new Date("2026-07-20T00:00:00Z"),
    resolvedAt: null,
    ...over,
  };
}

function getReq(opts: { auth?: string; status?: string } = {}): NextRequest {
  const url = new URL("http://test.local/api/admin/post-drafts");
  if (opts.status !== undefined) url.searchParams.set("status", opts.status);
  const headers: Record<string, string> = {};
  if (opts.auth !== undefined) headers["authorization"] = opts.auth;
  return new NextRequest(url, { method: "GET", headers });
}

function postReq(opts: { auth?: string; body?: unknown; rawBody?: string }): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth !== undefined) headers["authorization"] = opts.auth;
  const body =
    opts.rawBody !== undefined
      ? opts.rawBody
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : undefined;
  return new NextRequest("http://test.local/api/admin/post-drafts", {
    method: "POST",
    headers,
    ...(body !== undefined ? { body } : {}),
  });
}

function deps(over: Partial<PostDraftsDeps> = {}): PostDraftsDeps {
  return {
    secret: SECRET,
    list: vi.fn().mockResolvedValue([draftRow()]),
    resolve: vi.fn().mockResolvedValue(true),
    ...over,
  };
}

describe("handleListPostDrafts", () => {
  it("500s when the server secret is unset (never an auth bypass)", async () => {
    const res = await handleListPostDrafts(
      getReq({ auth: `Bearer ${SECRET}` }),
      deps({ secret: undefined }),
    );
    expect(res.status).toBe(500);
  });

  it("401s when no Authorization header is present", async () => {
    const d = deps();
    const res = await handleListPostDrafts(getReq(), d);
    expect(res.status).toBe(401);
    expect(d.list).not.toHaveBeenCalled();
  });

  it("401s on a wrong bearer secret", async () => {
    const res = await handleListPostDrafts(getReq({ auth: "Bearer wrong-secret-value" }), deps());
    expect(res.status).toBe(401);
  });

  it("400s on an unknown status filter", async () => {
    const res = await handleListPostDrafts(
      getReq({ auth: `Bearer ${SECRET}`, status: "published" }),
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("lists pending drafts with a prefilled intent URL", async () => {
    const d = deps();
    const res = await handleListPostDrafts(getReq({ auth: `Bearer ${SECRET}` }), d);
    expect(res.status).toBe(200);
    expect(d.list).toHaveBeenCalledWith("draft");
    const json = (await res.json()) as {
      count: number;
      drafts: Array<{ id: string; intentUrl: string }>;
    };
    expect(json.count).toBe(1);
    const draft = json.drafts[0]!;
    expect(draft.id).toBe(DRAFT_ID);
    expect(draft.intentUrl).toMatch(/^https:\/\/x\.com\/intent\/tweet\?/);
    expect(draft.intentUrl).toContain("via=AntFleetDev");
    expect(decodeURIComponent(draft.intentUrl)).toContain("antfleet.dev/agents/0xabc");
  });

  it("passes an explicit status filter through", async () => {
    const d = deps({ list: vi.fn().mockResolvedValue([]) });
    const res = await handleListPostDrafts(
      getReq({ auth: `Bearer ${SECRET}`, status: "posted" }),
      d,
    );
    expect(res.status).toBe(200);
    expect(d.list).toHaveBeenCalledWith("posted");
  });
});

describe("handleResolvePostDraft", () => {
  it("401s and never resolves when auth fails", async () => {
    const d = deps();
    const res = await handleResolvePostDraft(
      postReq({ auth: "Bearer nope", body: { id: DRAFT_ID, action: "posted" } }),
      d,
    );
    expect(res.status).toBe(401);
    expect(d.resolve).not.toHaveBeenCalled();
  });

  it("400s on malformed JSON", async () => {
    const res = await handleResolvePostDraft(
      postReq({ auth: `Bearer ${SECRET}`, rawBody: "{not json" }),
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("400s on a non-uuid id", async () => {
    const res = await handleResolvePostDraft(
      postReq({ auth: `Bearer ${SECRET}`, body: { id: "abc", action: "posted" } }),
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("400s on an unknown action", async () => {
    const res = await handleResolvePostDraft(
      postReq({ auth: `Bearer ${SECRET}`, body: { id: DRAFT_ID, action: "archived" } }),
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("404s when the draft is unknown or already resolved", async () => {
    const d = deps({ resolve: vi.fn().mockResolvedValue(false) });
    const res = await handleResolvePostDraft(
      postReq({ auth: `Bearer ${SECRET}`, body: { id: DRAFT_ID, action: "dismissed" } }),
      d,
    );
    expect(res.status).toBe(404);
  });

  it("resolves a pending draft", async () => {
    const d = deps();
    const res = await handleResolvePostDraft(
      postReq({ auth: `Bearer ${SECRET}`, body: { id: DRAFT_ID, action: "posted" } }),
      d,
    );
    expect(res.status).toBe(200);
    expect(d.resolve).toHaveBeenCalledWith(DRAFT_ID, "posted");
    const json = (await res.json()) as { resolved: boolean; action: string };
    expect(json.resolved).toBe(true);
    expect(json.action).toBe("posted");
  });
});
