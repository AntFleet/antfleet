import { describe, expect, it, vi } from "vitest";
import { checkAcpRepoCooldown, checkAcpWalletRateLimit } from "./rate-limit";

describe("ACP rate limits", () => {
  it("blocks the 11th accepted ACP job for a client wallet in one hour", async () => {
    const now = new Date("2026-06-10T00:00:00Z");
    const q = {
      execute: vi.fn(async () =>
        Array.from({ length: 10 }, (_, i) => ({
          createdAt: new Date(now.getTime() - (10 - i) * 1000),
        })),
      ),
    };

    const result = await checkAcpWalletRateLimit(q as never, {
      clientWallet: "0x0000000000000000000000000000000000000001",
      now,
      limit: 10,
    });

    expect(result).toMatchObject({ ok: false, limit: 10 });
  });

  it("scopes wallet limits to ACP rows and the authenticated ACP client wallet", async () => {
    const q = { execute: vi.fn(async (_query: unknown) => []) };

    await checkAcpWalletRateLimit(q as never, {
      clientWallet: "0x000000000000000000000000000000000000CAFE",
      now: new Date("2026-06-10T00:00:00Z"),
    });

    const query = q.execute.mock.calls[0]?.[0] as
      | { queryChunks?: Array<string | { value?: string[] }> }
      | undefined;
    const sqlText =
      query?.queryChunks
        ?.map((chunk) => (typeof chunk === "string" ? "" : (chunk.value ?? []).join("")))
        .join("") ?? "";

    expect(sqlText).toContain("payment_rail = 'acp'");
    expect(sqlText).toContain("lower(acp_client_wallet)");
    expect(query?.queryChunks).toContain("0x000000000000000000000000000000000000cafe");
  });

  it("blocks fresh ACP jobs for a repo during the cooldown window", async () => {
    const now = new Date("2026-06-10T00:00:00Z");
    const q = {
      execute: vi.fn(async () => [{ createdAt: new Date(now.getTime() - 120_000) }]),
    };

    const result = await checkAcpRepoCooldown(q as never, {
      owner: "AntFleet",
      repo: "acp-fixture",
      now,
      cooldownSeconds: 600,
    });

    expect(result).toEqual({ ok: false, retryAfterSeconds: 480, cooldownSeconds: 600 });
  });

  it("scopes repo cooldowns to ACP rows without wallet assumptions", async () => {
    const q = { execute: vi.fn(async (_query: unknown) => []) };

    await checkAcpRepoCooldown(q as never, {
      owner: "AntFleet",
      repo: "ACP-Fixture",
      now: new Date("2026-06-10T00:00:00Z"),
    });

    const query = q.execute.mock.calls[0]?.[0] as
      | { queryChunks?: Array<string | { value?: string[] }> }
      | undefined;
    const sqlText =
      query?.queryChunks
        ?.map((chunk) => (typeof chunk === "string" ? "" : (chunk.value ?? []).join("")))
        .join("") ?? "";

    expect(sqlText).toContain("payment_rail = 'acp'");
    expect(sqlText).toContain("lower(repo_owner)");
    expect(sqlText).toContain("lower(repo_name)");
    expect(sqlText).not.toContain("caller_wallet");
    expect(query?.queryChunks).toContain("antfleet");
    expect(query?.queryChunks).toContain("acp-fixture");
  });
});
