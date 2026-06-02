import { describe, expect, it, vi } from "vitest";
import type { db } from "@/db";
import { creditChannelFromDeposit, markInstallationActiveIfFunded } from "./queries";

type DbQueryable = Pick<typeof db, "execute">;
type ExecCall = { sql: string };

function makeQueryable(responses: unknown[]): { q: DbQueryable; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const queue = [...responses];
  const execute = vi.fn(async (query: unknown) => {
    const sqlObj = query as { strings?: string[] };
    calls.push({ sql: Array.isArray(sqlObj.strings) ? sqlObj.strings.join("?") : String(query) });
    const response = queue.shift();
    if (response === undefined) throw new Error("unexpected execute call");
    return response;
  });
  return { q: { execute } as unknown as DbQueryable, calls };
}

describe("creditChannelFromDeposit", () => {
  it("inserts payment, credits balance, and activates installation in one statement", async () => {
    const { q, calls } = makeQueryable([
      { rows: [{ channelReady: true, inserted: true, credited: true, activated: true }] },
    ]);

    const credited = await creditChannelFromDeposit(q, {
      channelId: "channel-1",
      txHash: `0x${"a".repeat(64)}`,
      chainId: 8453,
      fromAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      amountUsdc: "5.000000",
      blockNumber: 100,
    });

    expect(credited).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("returns false for a replayed tx without touching balance or activation", async () => {
    const { q } = makeQueryable([
      { rows: [{ channelReady: true, inserted: false, credited: false, activated: false }] },
    ]);

    const credited = await creditChannelFromDeposit(q, {
      channelId: "channel-1",
      txHash: `0x${"a".repeat(64)}`,
      chainId: 8453,
      fromAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      amountUsdc: "5.000000",
      blockNumber: 100,
    });

    expect(credited).toBe(false);
  });
});

describe("markInstallationActiveIfFunded", () => {
  it("only activates when a channel satisfies the minimum balance", async () => {
    const { q, calls } = makeQueryable([{ rows: [{ id: "install-1" }] }]);

    const activated = await markInstallationActiveIfFunded(q, {
      installationRowId: "install-1",
      minBalanceUsdc: "5.00",
    });

    expect(activated).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
