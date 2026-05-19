import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { handleRoast, type RoastDeps } from "./route";

const BASE_URL = "https://www.antfleet.dev/api/roast";
const SALT = "0123456789abcdef";

beforeEach(() => {
  process.env["ROAST_IP_SALT"] = SALT;
  delete process.env["ROAST_GH_TOKEN"];
});

function makeReq(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return {
    url: BASE_URL,
    headers: new Headers(headers),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

function makeOctokit(size = 100): RoastDeps["createOctokit"] {
  return () => ({
    rest: {
      repos: {
        get: vi.fn().mockResolvedValue({
          data: {
            private: false,
            size,
          },
        }),
      },
    },
  });
}

function makeDeps(overrides: Partial<RoastDeps> = {}): RoastDeps {
  return {
    createSubmissionId: vi.fn(() => "test-submission-id"),
    createOctokit: makeOctokit(),
    isPublicRepo: vi.fn().mockResolvedValue(true),
    countRecentByIp: vi.fn().mockResolvedValue(0),
    countRecentByRepo: vi.fn().mockResolvedValue(0),
    insertSubmission: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as RoastDeps;
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repoUrl: "https://github.com/AntFleet/antfleet",
    submitterHandle: "aug.star-1",
    submitterEmail: "aug@example.com",
    ...overrides,
  };
}

const forwardedHeaders = { "x-forwarded-for": "203.0.113.10, 198.51.100.7" };

describe("handleRoast - input validation", () => {
  const cases = [
    {
      name: "missing repoUrl",
      body: { submitterEmail: "aug@example.com" },
    },
    {
      name: "non-github URL",
      body: validBody({ repoUrl: "https://gitlab.com/antfleet/antfleet" }),
    },
    {
      name: "invalid submitterEmail when present",
      body: validBody({ submitterEmail: "not-an-email" }),
    },
    {
      name: "submitterHandle with disallowed chars",
      body: validBody({ submitterHandle: "x y" }),
    },
  ];

  it.each(cases)("returns 400 zod error for $name", async ({ body }) => {
    const res = await handleRoast(makeReq(body, forwardedHeaders), makeDeps());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid-input" });
  });
});

describe("handleRoast - submission flow", () => {
  it("returns 200 with a submission id and statusUrl for a valid public repo", async () => {
    const deps = makeDeps();
    const res = await handleRoast(makeReq(validBody(), forwardedHeaders), deps);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.submissionId).toBe("test-submission-id");
    expect(body.submissionId).not.toBe("");
    expect(body.statusUrl).toBe(`/roasts/${body.submissionId}`);
    expect(deps.isPublicRepo).toHaveBeenCalledWith(expect.any(Object), "antfleet", "antfleet");
    expect(deps.insertSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "test-submission-id",
        repoUrl: "https://github.com/antfleet/antfleet",
        repoFullName: "antfleet/antfleet",
        status: "awaiting_approval",
      }),
    );
  });

  it("returns 400 repo-not-public when GitHub reports private or invisible", async () => {
    const res = await handleRoast(
      makeReq(validBody(), forwardedHeaders),
      makeDeps({ isPublicRepo: vi.fn().mockResolvedValue(false) }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "repo-not-public" });
  });

  it("returns 400 repo-too-large when the repo is over 500MB", async () => {
    const res = await handleRoast(
      makeReq(validBody(), forwardedHeaders),
      makeDeps({ createOctokit: makeOctokit(512001) }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "repo-too-large" });
  });

  it("returns 500 no-ip when x-forwarded-for is missing", async () => {
    const res = await handleRoast(makeReq(validBody()), makeDeps());

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "no-ip" });
  });

  it("returns 500 internal when ROAST_IP_SALT is missing", async () => {
    delete process.env["ROAST_IP_SALT"];
    const res = await handleRoast(makeReq(validBody(), forwardedHeaders), makeDeps());

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "internal" });
  });
});

describe("handleRoast - rate limits", () => {
  it("allows the 5th submission from an IP and rejects the 6th within 24h", async () => {
    const deps = makeDeps({
      countRecentByIp: vi.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(5),
    });

    const fifth = await handleRoast(makeReq(validBody(), forwardedHeaders), deps);
    const sixth = await handleRoast(makeReq(validBody(), forwardedHeaders), deps);

    expect(fifth.status).toBe(200);
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toMatchObject({ error: "rate-limited-ip" });
  });

  it("allows the first repo submission and rejects the second within 7d", async () => {
    const deps = makeDeps({
      countRecentByRepo: vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1),
    });

    const first = await handleRoast(makeReq(validBody(), forwardedHeaders), deps);
    const second = await handleRoast(makeReq(validBody(), forwardedHeaders), deps);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ error: "rate-limited-repo" });
  });
});
