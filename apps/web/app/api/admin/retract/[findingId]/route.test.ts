import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { handleRetract, type RetractDeps } from "./route";

const SECRET = "op-secret-value";

function req(opts: { auth?: string; body?: unknown; rawBody?: string }): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth !== undefined) headers["authorization"] = opts.auth;
  const body =
    opts.rawBody !== undefined
      ? opts.rawBody
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : undefined;
  return new NextRequest("http://test.local/api/admin/retract/abcd1234-0", {
    method: "POST",
    headers,
    ...(body !== undefined ? { body } : {}),
  });
}

function deps(over: Partial<RetractDeps> = {}): RetractDeps {
  return {
    secret: SECRET,
    retract: vi.fn().mockResolvedValue(true),
    ...over,
  };
}

describe("handleRetract", () => {
  it("500s when the server secret is unset (never an auth bypass)", async () => {
    const res = await handleRetract(
      req({ auth: `Bearer ${SECRET}`, body: { reason: "x" } }),
      "abcd1234-0",
      deps({ secret: undefined }),
    );
    expect(res.status).toBe(500);
  });

  it("401s when no Authorization header is present", async () => {
    const res = await handleRetract(req({ body: { reason: "x" } }), "abcd1234-0", deps());
    expect(res.status).toBe(401);
  });

  it("401s on a wrong bearer secret", async () => {
    const res = await handleRetract(
      req({ auth: "Bearer wrong-secret-value", body: { reason: "x" } }),
      "abcd1234-0",
      deps(),
    );
    expect(res.status).toBe(401);
  });

  it("does not call retract when auth fails", async () => {
    const d = deps();
    await handleRetract(req({ auth: "Bearer nope", body: { reason: "x" } }), "abcd1234-0", d);
    expect(d.retract).not.toHaveBeenCalled();
  });

  it("400s when reason is missing", async () => {
    const res = await handleRetract(
      req({ auth: `Bearer ${SECRET}`, body: { requestorEmail: "a@b.com" } }),
      "abcd1234-0",
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("400s when reason is blank", async () => {
    const res = await handleRetract(
      req({ auth: `Bearer ${SECRET}`, body: { reason: "   " } }),
      "abcd1234-0",
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("400s on invalid JSON", async () => {
    const res = await handleRetract(
      req({ auth: `Bearer ${SECRET}`, rawBody: "{not json" }),
      "abcd1234-0",
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("404s when the finding is unknown or already retracted", async () => {
    const res = await handleRetract(
      req({ auth: `Bearer ${SECRET}`, body: { reason: "false positive" } }),
      "ghost-0",
      deps({ retract: vi.fn().mockResolvedValue(false) }),
    );
    expect(res.status).toBe(404);
  });

  it("200s and reports the retraction on success", async () => {
    const retract = vi.fn().mockResolvedValue(true);
    const res = await handleRetract(
      req({
        auth: `Bearer ${SECRET}`,
        body: { reason: "false positive", requestorEmail: "maint@example.com" },
      }),
      "abcd1234-0",
      deps({ retract }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ retracted: true, findingId: "abcd1234-0" });
    expect(retract).toHaveBeenCalledWith("abcd1234-0", "false positive", "maint@example.com");
  });

  it("passes null requestorEmail when omitted", async () => {
    const retract = vi.fn().mockResolvedValue(true);
    await handleRetract(
      req({ auth: `Bearer ${SECRET}`, body: { reason: "false positive" } }),
      "abcd1234-0",
      deps({ retract }),
    );
    expect(retract).toHaveBeenCalledWith("abcd1234-0", "false positive", null);
  });

  it("500s when the retract write throws", async () => {
    const res = await handleRetract(
      req({ auth: `Bearer ${SECRET}`, body: { reason: "x" } }),
      "abcd1234-0",
      deps({ retract: vi.fn().mockRejectedValue(new Error("db down")) }),
    );
    expect(res.status).toBe(500);
  });
});
