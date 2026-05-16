import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the orchestrator so the route test only exercises auth + envelope.
vi.mock("@/lib/sweep", () => ({
  runSweep: vi.fn().mockResolvedValue({
    swept: 3,
    closed: 1,
    reactionsRecorded: 2,
    reviewsSkipped: 0,
    errors: [],
  }),
}));

// Silence the route's structured logger so test output stays clean.
vi.mock("@/lib/log", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { GET } from "./route";

function mkRequest(headers: Record<string, string> = {}) {
  // The route only reads `req.headers.get("authorization")` — a Headers-shaped
  // stand-in is enough without bringing the full NextRequest constructor in.
  return {
    headers: new Headers(headers),
  } as unknown as Parameters<typeof GET>[0];
}

describe("/api/cron/sweep route", () => {
  const ORIGINAL_SECRET = process.env["CRON_SECRET"];

  beforeEach(() => {
    process.env["CRON_SECRET"] = "test-secret";
  });
  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env["CRON_SECRET"];
    } else {
      process.env["CRON_SECRET"] = ORIGINAL_SECRET;
    }
  });

  it("returns 500 when CRON_SECRET is not configured on the server", async () => {
    delete process.env["CRON_SECRET"];
    const res = await GET(mkRequest({ authorization: "Bearer test-secret" }));
    expect(res.status).toBe(500);
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const res = await GET(mkRequest());
    expect(res.status).toBe(401);
  });

  it("returns 401 when the Authorization header is the wrong secret", async () => {
    const res = await GET(mkRequest({ authorization: "Bearer wrong-secret" }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when the Authorization header is missing the Bearer prefix", async () => {
    const res = await GET(mkRequest({ authorization: "test-secret" }));
    expect(res.status).toBe(401);
  });

  it("returns 200 and runSweep's result on a valid request", async () => {
    const res = await GET(mkRequest({ authorization: "Bearer test-secret" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      swept: 3,
      closed: 1,
      reactionsRecorded: 2,
      reviewsSkipped: 0,
      errors: [],
    });
    expect(typeof body["elapsedMs"]).toBe("number");
  });
});
