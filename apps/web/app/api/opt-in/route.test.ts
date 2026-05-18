import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { handleOptIn, type OptInDeps } from "./route";
import { OPTIN_TOKEN_TTL_MS, signToken } from "@/lib/optin-token";

const SECRET = "test-secret-for-route";

beforeEach(() => {
  process.env["OPTIN_HMAC_SECRET"] = SECRET;
});

function makeReq(url: string): NextRequest {
  return { url } as unknown as NextRequest;
}

function makeDeps(overrides: Partial<OptInDeps> = {}): OptInDeps {
  return {
    flipReceipt: vi.fn().mockResolvedValue({
      alreadyMatching: 0,
      flipped: 0,
      totalMatching: 0,
    }),
    recordEvent: vi.fn().mockResolvedValue("event-id"),
    ...overrides,
  };
}

const payload = { installationId: 999, owner: "AntFleet", repo: "antfleet" };
const baseUrl = "https://www.antfleet.dev/api/opt-in";

describe("handleOptIn — token validation", () => {
  it("returns 400 when token is missing", async () => {
    const res = await handleOptIn(makeReq(baseUrl), makeDeps());
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Missing token");
  });

  it("returns 400 for malformed token", async () => {
    const res = await handleOptIn(makeReq(`${baseUrl}?t=garbage`), makeDeps());
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid link");
  });

  it("returns 410 for expired token", async () => {
    const long_ago = new Date(Date.now() - 2 * OPTIN_TOKEN_TTL_MS);
    const token = signToken(payload, long_ago);
    const res = await handleOptIn(makeReq(`${baseUrl}?t=${token}`), makeDeps());
    expect(res.status).toBe(410);
    expect(await res.text()).toContain("Link expired");
  });

  it("returns 400 for HMAC-tampered token", async () => {
    const token = signToken(payload);
    const [body, mac] = token.split(".");
    const tamperedChar = mac!.charAt(0) === "A" ? "B" : "A";
    const tampered = `${body}.${tamperedChar}${mac!.slice(1)}`;
    const res = await handleOptIn(makeReq(`${baseUrl}?t=${tampered}`), makeDeps());
    expect(res.status).toBe(400);
  });
});

describe("handleOptIn — enable flow", () => {
  it("flips the flag and emits public_receipts_enabled when reviews exist and were not already public", async () => {
    const token = signToken(payload);
    const flipReceipt = vi.fn().mockResolvedValue({
      alreadyMatching: 0,
      flipped: 3,
      totalMatching: 3,
    });
    const recordEvent = vi.fn().mockResolvedValue("id");
    const res = await handleOptIn(
      makeReq(`${baseUrl}?t=${token}`),
      makeDeps({ flipReceipt, recordEvent }),
    );
    expect(res.status).toBe(200);
    expect(flipReceipt).toHaveBeenCalledWith({
      installationId: 999,
      owner: "AntFleet",
      repo: "antfleet",
      target: true,
    });
    expect(recordEvent).toHaveBeenCalledTimes(1);
    const event = recordEvent.mock.calls[0]![0]!;
    expect(event.eventType).toBe("public_receipts_enabled");
    expect(event.installationId).toBe(999);
    expect(event.owner).toBe("AntFleet");
    expect(event.repo).toBe("antfleet");
    expect(event.public).toBe(true);
    expect(event.modelId).toBeNull();
    expect(event.prompt).toBeNull();
    expect(event.toolOutput).toMatchObject({ flipped_review_count: 3 });
    expect(await res.text()).toContain("Public receipts enabled");
  });

  it("is idempotent — already-enabled does not emit duplicate event", async () => {
    const token = signToken(payload);
    const flipReceipt = vi.fn().mockResolvedValue({
      alreadyMatching: 4,
      flipped: 0,
      totalMatching: 4,
    });
    const recordEvent = vi.fn();
    const res = await handleOptIn(
      makeReq(`${baseUrl}?t=${token}`),
      makeDeps({ flipReceipt, recordEvent }),
    );
    expect(res.status).toBe(200);
    expect(recordEvent).not.toHaveBeenCalled();
    expect(await res.text()).toContain("Already enabled");
  });

  it("renders 'no reviews here yet' when totalMatching == 0", async () => {
    const token = signToken(payload);
    const flipReceipt = vi.fn().mockResolvedValue({
      alreadyMatching: 0,
      flipped: 0,
      totalMatching: 0,
    });
    const recordEvent = vi.fn();
    const res = await handleOptIn(
      makeReq(`${baseUrl}?t=${token}`),
      makeDeps({ flipReceipt, recordEvent }),
    );
    expect(res.status).toBe(200);
    expect(recordEvent).not.toHaveBeenCalled();
    expect(await res.text()).toContain("No reviews here yet");
  });
});

describe("handleOptIn — disable flow", () => {
  it("flips to false and emits public_receipts_disabled with public=false", async () => {
    const token = signToken(payload);
    const flipReceipt = vi.fn().mockResolvedValue({
      alreadyMatching: 0,
      flipped: 2,
      totalMatching: 2,
    });
    const recordEvent = vi.fn().mockResolvedValue("id");
    const res = await handleOptIn(
      makeReq(`${baseUrl}?t=${token}&action=disable`),
      makeDeps({ flipReceipt, recordEvent }),
    );
    expect(res.status).toBe(200);
    expect(flipReceipt).toHaveBeenCalledWith({
      installationId: 999,
      owner: "AntFleet",
      repo: "antfleet",
      target: false,
    });
    const event = recordEvent.mock.calls[0]![0]!;
    expect(event.eventType).toBe("public_receipts_disabled");
    expect(event.public).toBe(false);
    expect(await res.text()).toContain("Public receipts disabled");
  });
});

describe("handleOptIn — surface behavior", () => {
  it("returns HTML content-type and no-cache on success", async () => {
    const token = signToken(payload);
    const res = await handleOptIn(
      makeReq(`${baseUrl}?t=${token}`),
      makeDeps({
        flipReceipt: vi.fn().mockResolvedValue({
          alreadyMatching: 0,
          flipped: 1,
          totalMatching: 1,
        }),
      }),
    );
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/u);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("escapes owner/repo when rendering — no HTML injection from payload", async () => {
    // A maliciously-encoded payload would still have to round-trip the HMAC,
    // which means anyone with that capability already owns the secret. But
    // belt-and-braces: never trust strings in templates.
    const evilPayload = { installationId: 1, owner: "<script>x</script>", repo: "y" };
    const token = signToken(evilPayload);
    const res = await handleOptIn(
      makeReq(`${baseUrl}?t=${token}`),
      makeDeps({
        flipReceipt: vi.fn().mockResolvedValue({
          alreadyMatching: 0,
          flipped: 1,
          totalMatching: 1,
        }),
      }),
    );
    const body = await res.text();
    expect(body).not.toContain("<script>x</script>");
    expect(body).toContain("&lt;script&gt;");
  });

  it("does not 5xx if recordEvent throws — flip already happened", async () => {
    const token = signToken(payload);
    const flipReceipt = vi.fn().mockResolvedValue({
      alreadyMatching: 0,
      flipped: 1,
      totalMatching: 1,
    });
    const recordEvent = vi.fn().mockRejectedValue(new Error("audit db down"));
    const res = await handleOptIn(
      makeReq(`${baseUrl}?t=${token}`),
      makeDeps({ flipReceipt, recordEvent }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Public receipts enabled");
  });
});
