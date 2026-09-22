import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/log", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  messageOf: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { GET } from "./route";

function mkRequest(headers: Record<string, string> = {}) {
  return {
    headers: new Headers(headers),
  } as unknown as Parameters<typeof GET>[0];
}

describe("/api/cron/curate-weekly route", () => {
  const ORIGINAL_SECRET = process.env["CRON_SECRET"];
  const ORIGINAL_DATABASE_URL = process.env["DATABASE_URL"];

  beforeEach(() => {
    process.env["CRON_SECRET"] = "test-secret";
    process.env["DATABASE_URL"] = "postgres://example";
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env["CRON_SECRET"];
    } else {
      process.env["CRON_SECRET"] = ORIGINAL_SECRET;
    }
    if (ORIGINAL_DATABASE_URL === undefined) {
      delete process.env["DATABASE_URL"];
    } else {
      process.env["DATABASE_URL"] = ORIGINAL_DATABASE_URL;
    }
  });

  it("returns 500 when CRON_SECRET is not configured on the server", async () => {
    delete process.env["CRON_SECRET"];
    const res = await GET(mkRequest({ authorization: "Bearer test-secret" }));
    expect(res.status).toBe(500);
  });

  it("returns 401 when the Authorization header is the wrong secret", async () => {
    const res = await GET(mkRequest({ authorization: "Bearer wrong-secret" }));
    expect(res.status).toBe(401);
  });

  // Neon DB access is intentionally disabled (apps/web/db/index.ts) to stop
  // Neon billing on this parked project — this route never reaches curateWeekly
  // or opens a Pool anymore, even with a correctly authorized request.
  it("returns 500 server-misconfigured on a validly authorized request, without touching the DB", async () => {
    const res = await GET(mkRequest({ authorization: "Bearer test-secret" }));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("server misconfigured");
  });
});
