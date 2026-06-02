import { describe, expect, it, vi } from "vitest";
import {
  checkWalletRateLimit,
  claimX402ScanAuthorization,
  findRecentRepoShaJob,
  markX402ScanClaimStatus,
} from "./rate-limit";

describe("x402 rate limit", () => {
  it("blocks the 11th wallet job when 10 in-flight jobs are already in the window", async () => {
    const now = new Date("2026-05-29T00:00:00Z");
    const q = {
      execute: vi.fn(async () =>
        Array.from({ length: 10 }, (_, i) => ({
          createdAt: new Date(now.getTime() - (10 - i) * 1000),
        })),
      ),
    };

    const result = await checkWalletRateLimit(q as never, {
      callerWallet: "0x0000000000000000000000000000000000000001",
      now,
      limit: 10,
    });

    expect(result).toMatchObject({ ok: false, limit: 10 });
  });

  it("allows the current claimed scan to be the 10th wallet use", async () => {
    const now = new Date("2026-05-29T00:00:00Z");
    const q = {
      execute: vi.fn(async () =>
        Array.from({ length: 10 }, (_, i) => ({
          createdAt: new Date(now.getTime() - (10 - i) * 1000),
        })),
      ),
    };

    const result = await checkWalletRateLimit(q as never, {
      callerWallet: "0x0000000000000000000000000000000000000001",
      now,
      limit: 10,
      includeCurrent: true,
    });

    expect(result).toEqual({ ok: true });
  });

  it("claims each x402 scan authorization only once", async () => {
    const q = { execute: vi.fn(async () => ({ rows: [{ id: "claim-1" }] })) };

    const result = await claimX402ScanAuthorization(q as never, {
      authorizationKey: "auth-key",
      callerWallet: "0x0000000000000000000000000000000000000001",
      owner: "antfleet",
      repo: "scan-fixture",
      now: new Date("2026-05-29T00:00:00Z"),
    });

    expect(result).toEqual({ claimed: true, claimId: "claim-1" });
  });

  it("reports duplicate x402 scan authorizations when the insert conflicts", async () => {
    const q = { execute: vi.fn(async () => ({ rows: [] })) };

    const result = await claimX402ScanAuthorization(q as never, {
      authorizationKey: "auth-key",
      callerWallet: "0x0000000000000000000000000000000000000001",
      owner: "antfleet",
      repo: "scan-fixture",
      now: new Date("2026-05-29T00:00:00Z"),
    });

    expect(result).toEqual({ claimed: false, reason: "duplicate_authorization" });
  });

  it("finalizes a claimed x402 scan with terminal status metadata", async () => {
    const q = { execute: vi.fn(async () => ({ rows: [] })) };

    await markX402ScanClaimStatus(q as never, {
      claimId: "claim-1",
      status: "settled",
      now: new Date("2026-05-29T00:00:00Z"),
      headSha: "abc1234",
      settlementResponse: { txHash: "0xsettled" },
    });

    expect(q.execute).toHaveBeenCalledOnce();
  });

  it("scopes repo/sha cooldown lookups to the verified caller wallet", async () => {
    const q = {
      execute: vi.fn(async (_query: unknown) => []),
    };

    await findRecentRepoShaJob(q as never, {
      owner: "AntFleet",
      repo: "X402-Fixture",
      sha: "ABC1234",
      callerWallet: "0x000000000000000000000000000000000000CAFE",
      now: new Date("2026-05-29T00:00:00Z"),
    });

    const query = q.execute.mock.calls[0]?.[0] as
      | { queryChunks?: Array<string | { value?: string[] }> }
      | undefined;
    const sqlText =
      query?.queryChunks
        ?.map((chunk) => (typeof chunk === "string" ? "" : (chunk.value ?? []).join("")))
        .join("") ?? "";

    expect(sqlText).toContain("lower(caller_wallet)");
    expect(query?.queryChunks).toContain("0x000000000000000000000000000000000000cafe");
  });
});
