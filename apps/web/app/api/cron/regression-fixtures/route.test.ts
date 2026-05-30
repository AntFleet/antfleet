import { NextRequest } from "next/server";
import { describe, it, expect, vi } from "vitest";
import { handleRegressionFixtures, type RegressionDeps } from "./route";
import type { RegressionResult } from "@/lib/regression-fixtures-cron";

const SECRET = "cron-secret-value";

const okResult: RegressionResult = {
  ran: 6,
  passed: 6,
  failed: 0,
  degraded: 0,
  failures: [],
  degradedFixtures: [],
  details: [],
};

const failResult: RegressionResult = {
  ran: 6,
  passed: 5,
  failed: 1,
  degraded: 0,
  failures: ["rust-nonnull-unchecked"],
  degradedFixtures: [],
  details: [{ fixtureId: "rust-nonnull-unchecked", agreedCount: 1, degraded: false }],
};

function req(auth?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (auth !== undefined) headers["authorization"] = auth;
  return new NextRequest("http://test.local/api/cron/regression-fixtures", { headers });
}

function deps(over: Partial<RegressionDeps> = {}): RegressionDeps {
  return { secret: SECRET, run: vi.fn().mockResolvedValue(okResult), ...over };
}

describe("handleRegressionFixtures", () => {
  it("500s when CRON_SECRET is unset", async () => {
    const res = await handleRegressionFixtures(
      req(`Bearer ${SECRET}`),
      deps({ secret: undefined }),
    );
    expect(res.status).toBe(500);
  });

  it("401s with no Authorization header and does not run the suite", async () => {
    const d = deps();
    const res = await handleRegressionFixtures(req(), d);
    expect(res.status).toBe(401);
    expect(d.run).not.toHaveBeenCalled();
  });

  it("401s on a wrong secret", async () => {
    const res = await handleRegressionFixtures(req("Bearer nope"), deps());
    expect(res.status).toBe(401);
  });

  it("200s with the summary when all fixtures pass", async () => {
    const res = await handleRegressionFixtures(req(`Bearer ${SECRET}`), deps());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ran: 6, failed: 0, failures: [] });
  });

  it("200s (not 500) when fixtures only DEGRADED — a provider outage is not drift", async () => {
    const degradedResult: RegressionResult = {
      ran: 6,
      passed: 6,
      failed: 0,
      degraded: 2,
      failures: [],
      degradedFixtures: ["rust-nonnull-unchecked", "bash-curl-checksummed"],
      details: [],
    };
    const res = await handleRegressionFixtures(
      req(`Bearer ${SECRET}`),
      deps({ run: vi.fn().mockResolvedValue(degradedResult) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ failed: 0, degraded: 2 });
  });

  it("500s and lists the fired fixture when the gate drifts", async () => {
    const res = await handleRegressionFixtures(
      req(`Bearer ${SECRET}`),
      deps({ run: vi.fn().mockResolvedValue(failResult) }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ failed: 1, failures: ["rust-nonnull-unchecked"] });
  });

  it("500s when the run itself throws", async () => {
    const res = await handleRegressionFixtures(
      req(`Bearer ${SECRET}`),
      deps({ run: vi.fn().mockRejectedValue(new Error("provider down")) }),
    );
    expect(res.status).toBe(500);
  });
});
