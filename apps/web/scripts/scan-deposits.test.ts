import { describe, expect, it, vi } from "vitest";
import {
  buildLiveDeps,
  scanDepositsWithDeps,
  type ChannelRow,
  type ScanDepositsDeps,
  type TransferLog,
} from "./scan-deposits";

const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CHANNEL_A = "channel-a";

function transferLog(args: {
  from: string;
  txHash: string;
  blockNumber: bigint;
  valueRaw: bigint;
}): TransferLog {
  return {
    from: args.from,
    to: "0xdeposit",
    value: args.valueRaw,
    blockNumber: args.blockNumber,
    txHash: args.txHash,
  };
}

function makeDeps(opts: {
  cursorAt?: bigint | null;
  currentBlock: bigint;
  logs: TransferLog[][];
  channels?: Record<string, ChannelRow | null>;
  creditedTxHashes?: Set<string>;
}): ScanDepositsDeps & {
  state: {
    cursor: bigint | null;
    creditCalls: Array<{ channelId: string; txHash: string; amount: string }>;
  };
} {
  const channelMap = opts.channels ?? {};
  const alreadyCredited = new Set(opts.creditedTxHashes ?? []);
  const state = {
    cursor: opts.cursorAt ?? null,
    creditCalls: [] as Array<{ channelId: string; txHash: string; amount: string }>,
  };
  let logCallIndex = 0;
  return {
    state,
    getCurrentBlock: vi.fn(async () => opts.currentBlock),
    getLogs: vi.fn(async () => {
      const next = opts.logs[logCallIndex] ?? [];
      logCallIndex += 1;
      return next;
    }),
    readCursor: vi.fn(async () => state.cursor),
    writeCursor: vi.fn(async (block) => {
      state.cursor = block;
    }),
    loadChannelByWallet: vi.fn(async (wallet) => channelMap[wallet] ?? null),
    creditDeposit: vi.fn(async (args) => {
      state.creditCalls.push({
        channelId: args.channelId,
        txHash: args.txHash,
        amount: args.amountUsdc,
      });
      if (alreadyCredited.has(args.txHash)) return false;
      alreadyCredited.add(args.txHash);
      return true;
    }),
  };
}

describe("scanDepositsWithDeps", () => {
  it("credits a new USDC Transfer from a known wallet", async () => {
    const deps = makeDeps({
      cursorAt: 999n,
      currentBlock: 1_005n,
      logs: [
        [
          transferLog({
            from: WALLET_A,
            txHash: "0xfeed",
            blockNumber: 1_001n,
            valueRaw: 5_000_000n,
          }),
        ],
      ],
      channels: { [WALLET_A]: { id: CHANNEL_A, walletAddress: WALLET_A } },
    });

    const result = await scanDepositsWithDeps(deps);

    expect(result.scanned).toBe(1);
    expect(result.credited).toBe(1);
    expect(result.unmatched).toBe(0);
    expect(deps.state.creditCalls).toEqual([
      { channelId: CHANNEL_A, txHash: "0xfeed", amount: "5.000000" },
    ]);
    expect(deps.state.cursor).toBe(1_003n); // currentBlock 1005 - 3 + 1
  });

  it("ignores Transfers from wallets without a channel", async () => {
    const deps = makeDeps({
      cursorAt: 999n,
      currentBlock: 1_005n,
      logs: [
        [
          transferLog({ from: WALLET_A, txHash: "0xa", blockNumber: 1_000n, valueRaw: 5_000_000n }),
          transferLog({ from: WALLET_B, txHash: "0xb", blockNumber: 1_001n, valueRaw: 5_000_000n }),
        ],
      ],
      channels: { [WALLET_A]: { id: CHANNEL_A, walletAddress: WALLET_A } },
    });

    const result = await scanDepositsWithDeps(deps);
    expect(result.scanned).toBe(2);
    expect(result.credited).toBe(1);
    expect(result.unmatched).toBe(1);
    expect(deps.state.creditCalls).toHaveLength(1);
    expect(deps.state.creditCalls[0]?.channelId).toBe(CHANNEL_A);
  });

  it("treats a replayed tx_hash as already-credited (no double-credit)", async () => {
    const deps = makeDeps({
      cursorAt: 999n,
      currentBlock: 1_005n,
      logs: [
        [
          transferLog({
            from: WALLET_A,
            txHash: "0xreplay",
            blockNumber: 1_000n,
            valueRaw: 5_000_000n,
          }),
        ],
      ],
      channels: { [WALLET_A]: { id: CHANNEL_A, walletAddress: WALLET_A } },
      creditedTxHashes: new Set(["0xreplay"]),
    });

    const result = await scanDepositsWithDeps(deps);
    expect(result.credited).toBe(0);
    expect(result.alreadyCredited).toBe(1);
  });

  it("no-ops when caught up", async () => {
    const deps = makeDeps({
      cursorAt: 1_004n,
      currentBlock: 1_005n,
      logs: [[]],
    });
    const result = await scanDepositsWithDeps(deps);
    expect(result.scanned).toBe(0);
    expect(deps.getLogs).not.toHaveBeenCalled();
  });

  it("advances the cursor after each chunk so partial progress survives RPC failures", async () => {
    const deps = makeDeps({
      cursorAt: 0n,
      currentBlock: 4_000n,
      logs: [[], []], // first chunk empty, second chunk fails
    });
    deps.getLogs = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("rpc range failed"));

    await expect(scanDepositsWithDeps(deps)).rejects.toThrow("rpc range failed");
    // Cursor should have been advanced past the first chunk (2000 blocks)
    // even though the second chunk failed.
    expect(deps.state.cursor).toBe(2_000n);
  });

  it("credits multiple deposits from the same wallet to the same channel", async () => {
    const deps = makeDeps({
      cursorAt: 999n,
      currentBlock: 1_010n,
      logs: [
        [
          transferLog({ from: WALLET_A, txHash: "0x1", blockNumber: 1_000n, valueRaw: 5_000_000n }),
          transferLog({ from: WALLET_A, txHash: "0x2", blockNumber: 1_001n, valueRaw: 7_500_000n }),
        ],
      ],
      channels: { [WALLET_A]: { id: CHANNEL_A, walletAddress: WALLET_A } },
    });

    const result = await scanDepositsWithDeps(deps);
    expect(result.credited).toBe(2);
    expect(deps.state.creditCalls.map((c) => c.amount)).toEqual(["5.000000", "7.500000"]);
  });

  it("starts from the USDC deploy block when cursor is unset", async () => {
    const deps = makeDeps({
      cursorAt: null,
      currentBlock: 5_086_770n,
      logs: [[]],
    });
    await scanDepositsWithDeps(deps);
    expect(deps.getLogs).toHaveBeenCalledWith({
      fromBlock: 5_086_768n,
      toBlock: 5_086_768n, // currentBlock - 3 + 1
    });
  });

  it("uses the partial tx_hash conflict predicate in the live credit path", async () => {
    const statements: unknown[] = [];
    const fakeDb = {
      execute: vi.fn(async (statement: unknown) => {
        statements.push(statement);
        return statements.length === 1 ? [{ id: "payment-id" }] : [];
      }),
    };
    const deps = buildLiveDeps(
      fakeDb as never,
      { getBlockNumber: vi.fn(), getLogs: vi.fn() } as never,
      "0xdddddddddddddddddddddddddddddddddddddddd",
    );

    await deps.creditDeposit({
      channelId: CHANNEL_A,
      txHash: "0xabc",
      fromAddress: WALLET_A,
      amountUsdc: "5.000000",
      blockNumber: 1_000,
    });

    expect(sqlText(statements[0])).toContain(
      "ON CONFLICT (chain_id, tx_hash) WHERE tx_hash IS NOT NULL DO NOTHING",
    );
  });

  it("does not guess when a wallet has multiple eligible installations", async () => {
    const fakeDb = {
      execute: vi.fn(async () => [
        { installationId: "install-a", channelId: "channel-a", walletAddress: WALLET_A },
        { installationId: "install-b", channelId: "channel-b", walletAddress: WALLET_A },
      ]),
    };
    const deps = buildLiveDeps(
      fakeDb as never,
      { getBlockNumber: vi.fn(), getLogs: vi.fn() } as never,
      "0xdddddddddddddddddddddddddddddddddddddddd",
    );

    await expect(deps.loadChannelByWallet(WALLET_A)).resolves.toBeNull();

    expect(fakeDb.execute).toHaveBeenCalledTimes(1);
  });

  it("creates the channel for a single eligible first-deposit installation", async () => {
    const statements: unknown[] = [];
    const fakeDb = {
      execute: vi
        .fn()
        .mockImplementationOnce(async (statement: unknown) => {
          statements.push(statement);
          return [{ installationId: "install-a", channelId: null, walletAddress: WALLET_A }];
        })
        .mockImplementationOnce(async (statement: unknown) => {
          statements.push(statement);
          return [{ id: "created-channel", walletAddress: WALLET_A }];
        }),
    };
    const deps = buildLiveDeps(
      fakeDb as never,
      { getBlockNumber: vi.fn(), getLogs: vi.fn() } as never,
      "0xdddddddddddddddddddddddddddddddddddddddd",
    );

    await expect(deps.loadChannelByWallet(WALLET_A)).resolves.toEqual({
      id: "created-channel",
      walletAddress: WALLET_A,
    });
    expect(sqlText(statements[1])).toContain("INSERT INTO channels");
    expect(sqlText(statements[1])).toContain("ON CONFLICT (installation_id)");
  });
});

function sqlText(statement: unknown): string {
  const chunks = (statement as { queryChunks?: Array<{ value?: unknown }> }).queryChunks ?? [];
  return chunks.map((chunk) => (Array.isArray(chunk.value) ? chunk.value.join("") : "")).join("");
}
