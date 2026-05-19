import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const end = vi.fn().mockResolvedValue(undefined);
  return {
    end,
    Pool: vi.fn().mockImplementation(function Pool() {
      return { end };
    }),
    curateWeekly: vi.fn().mockResolvedValue({
      status: "featured",
      weekStart: "2026-05-18",
      pickedFindingId: "finding-a",
      rationale: "auto: high · published 2026-05-18",
      draftPath: null,
    }),
  };
});

vi.mock("@neondatabase/serverless", () => ({ Pool: mocks.Pool }));
vi.mock("@/lib/curate-weekly", () => ({ curateWeekly: mocks.curateWeekly }));
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
    mocks.end.mockResolvedValue(undefined);
    mocks.curateWeekly.mockResolvedValue({
      status: "featured",
      weekStart: "2026-05-18",
      pickedFindingId: "finding-a",
      rationale: "auto: high · published 2026-05-18",
      draftPath: null,
    });
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
    expect(mocks.curateWeekly).not.toHaveBeenCalled();
  });

  it("returns 401 when the Authorization header is the wrong secret", async () => {
    const res = await GET(mkRequest({ authorization: "Bearer wrong-secret" }));
    expect(res.status).toBe(401);
    expect(mocks.curateWeekly).not.toHaveBeenCalled();
  });

  it("calls curateWeekly once and returns its result on a valid request", async () => {
    const res = await GET(mkRequest({ authorization: "Bearer test-secret" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "featured",
      weekStart: "2026-05-18",
      pickedFindingId: "finding-a",
      rationale: "auto: high · published 2026-05-18",
      draftPath: null,
    });
    expect(typeof body["elapsedMs"]).toBe("number");
    expect(mocks.Pool).toHaveBeenCalledWith({ connectionString: "postgres://example" });
    expect(mocks.curateWeekly).toHaveBeenCalledOnce();
    expect(mocks.curateWeekly).toHaveBeenCalledWith({ pool: { end: mocks.end }, apply: true });
    expect(mocks.end).toHaveBeenCalledOnce();
  });
});
