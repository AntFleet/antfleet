import { afterEach, describe, expect, it, vi } from "vitest";
import { alertCritical, alertTestSeam } from "./alert";

// Stub for fetch; captures calls without hitting the network.
function makeFetchStub() {
  const calls: Array<{ url: string; body: unknown }> = [];
  const stub = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ url, body });
    return new Response(null, { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { stub, calls };
}

describe("alertCritical", () => {
  const WEBHOOK_URL = "https://hooks.example.com/test-webhook";

  afterEach(() => {
    alertTestSeam.resetFetch();
    delete process.env["ANTFLEET_ALERT_WEBHOOK_URL"];
  });

  it("is a no-op when ANTFLEET_ALERT_WEBHOOK_URL is not set", () => {
    delete process.env["ANTFLEET_ALERT_WEBHOOK_URL"];
    const { stub } = makeFetchStub();
    alertTestSeam.setFetch(stub);

    alertCritical("worker.failed", { reviewId: "rev-1" });

    expect(stub).not.toHaveBeenCalled();
  });

  it("is a no-op when ANTFLEET_ALERT_WEBHOOK_URL is empty string", () => {
    process.env["ANTFLEET_ALERT_WEBHOOK_URL"] = "";
    const { stub } = makeFetchStub();
    alertTestSeam.setFetch(stub);

    alertCritical("worker.failed", { reviewId: "rev-1" });

    expect(stub).not.toHaveBeenCalled();
  });

  it("fires a POST to the webhook when URL is set", async () => {
    process.env["ANTFLEET_ALERT_WEBHOOK_URL"] = WEBHOOK_URL;
    const { stub, calls } = makeFetchStub();
    alertTestSeam.setFetch(stub);

    alertCritical("worker.failed", { reviewId: "rev-1", source: "cron" });

    // Fire-and-forget: flush micro-task queue so the promise resolves.
    await new Promise((r) => setTimeout(r, 0));

    expect(stub).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = (stub as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe(WEBHOOK_URL);
    expect(calledInit.method).toBe("POST");
    const body = JSON.parse(calledInit.body as string) as {
      text: string;
      event: string;
      payload: Record<string, unknown>;
      ts: string;
    };
    expect(body.event).toBe("worker.failed");
    expect(body.text).toContain("worker.failed");
    expect(body.payload["reviewId"]).toBe("rev-1");
    expect(calls).toHaveLength(1);
  });

  it("sanitizes sensitive keys out of the payload", async () => {
    process.env["ANTFLEET_ALERT_WEBHOOK_URL"] = WEBHOOK_URL;
    const { stub } = makeFetchStub();
    alertTestSeam.setFetch(stub);

    alertCritical("worker.failed", {
      reviewId: "rev-safe",
      token: "ghp_secret_token",
      apiKey: "sk-xxxx",
      authorization: "Bearer xyz",
      password: "hunter2",
      source: "cron",
    });

    await new Promise((r) => setTimeout(r, 0));

    const [, calledInit] = (stub as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(calledInit.body as string) as { payload: Record<string, unknown> };
    expect(body.payload).not.toHaveProperty("token");
    expect(body.payload).not.toHaveProperty("apiKey");
    expect(body.payload).not.toHaveProperty("authorization");
    expect(body.payload).not.toHaveProperty("password");
    expect(body.payload["reviewId"]).toBe("rev-safe");
    expect(body.payload["source"]).toBe("cron");
  });

  it("truncates long string values in the payload", async () => {
    process.env["ANTFLEET_ALERT_WEBHOOK_URL"] = WEBHOOK_URL;
    const { stub } = makeFetchStub();
    alertTestSeam.setFetch(stub);

    const longString = "x".repeat(500);
    alertCritical("worker.failed", { reviewId: "rev-1", error: longString });

    await new Promise((r) => setTimeout(r, 0));

    const [, calledInit] = (stub as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(calledInit.body as string) as { payload: Record<string, unknown> };
    expect(typeof body.payload["error"]).toBe("string");
    expect((body.payload["error"] as string).length).toBeLessThanOrEqual(200);
  });

  it("does not throw when the webhook fetch rejects", async () => {
    process.env["ANTFLEET_ALERT_WEBHOOK_URL"] = WEBHOOK_URL;
    const failingFetch = vi.fn().mockRejectedValue(new Error("network error"));
    alertTestSeam.setFetch(failingFetch as unknown as typeof globalThis.fetch);

    // Must not throw synchronously or asynchronously to the caller.
    expect(() => alertCritical("worker.failed", { reviewId: "rev-1" })).not.toThrow();

    // Flush: the rejection is caught internally and logged, not re-thrown.
    await new Promise((r) => setTimeout(r, 0));
  });
});
