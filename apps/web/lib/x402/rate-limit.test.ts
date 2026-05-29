import { describe, expect, it, vi } from "vitest";
import { checkWalletRateLimit } from "./rate-limit";

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
});
