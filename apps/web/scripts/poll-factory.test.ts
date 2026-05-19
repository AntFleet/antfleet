import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  cursors: new Map<string, string>(),
  launches: new Map<string, unknown>(),
  blocks: new Map<bigint, { timestamp: bigint }>(),
  getLogs: vi.fn(),
  getBlockNumber: vi.fn(),
  getCode: vi.fn(),
  getBlock: vi.fn(),
}));

vi.mock("@neondatabase/serverless", () => ({
  Pool: class FakePool {
    end() {
      return Promise.resolve();
    }
  },
}));

vi.mock("../lib/log", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  messageOf: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

vi.mock("../db/schema", () => ({
  cronCursors: { key: "key", value: "value", tableName: "cron_cursors" },
  factoryLaunches: { tokenAddress: "tokenAddress", tableName: "factory_launches" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (_column: unknown, value: string) => ({ value }),
}));

function makeDb() {
  return {
    select() {
      return {
        from() {
          return {
            where(condition: { value: string }) {
              const value = state.cursors.get(condition.value);
              return Promise.resolve(value === undefined ? [] : [{ value }]);
            },
          };
        },
      };
    },
    insert(table: { tableName: string }) {
      return {
        values(input: unknown) {
          return makeInsert(table.tableName, input);
        },
      };
    },
  };
}

function makeInsert(table: string, input: unknown) {
  const query = {
    onConflictDoUpdate() {
      if (table === "cron_cursors") {
        const row = input as { key: string; value: string };
        state.cursors.set(row.key, row.value);
      }
      return Promise.resolve();
    },
    onConflictDoNothing() {
      return {
        returning() {
          const inserted: Array<{ tokenAddress: string }> = [];
          for (const row of input as Array<{ tokenAddress: string }>) {
            if (!state.launches.has(row.tokenAddress)) {
              state.launches.set(row.tokenAddress, row);
              inserted.push({ tokenAddress: row.tokenAddress });
            }
          }
          return Promise.resolve(inserted);
        },
      };
    },
  };
  return query;
}

vi.mock("drizzle-orm/neon-serverless", () => ({ drizzle: vi.fn(() => makeDb()) }));

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getBlockNumber: state.getBlockNumber,
      getCode: state.getCode,
      getLogs: state.getLogs,
      getBlock: state.getBlock,
    })),
    http: vi.fn((url?: string) => ({ url })),
  };
});

function tokenLog(index: number, blockNumber: bigint) {
  return {
    args: {
      tokenAddress: `0x${index.toString(16).padStart(40, "0")}` as `0x${string}`,
      tokenAdmin: `0x${(index + 100).toString(16).padStart(40, "0")}` as `0x${string}`,
      tokenName: `Token ${index}`,
      tokenSymbol: `T${index}`,
    },
    blockNumber,
    transactionHash: `0x${index.toString(16).padStart(64, "0")}` as `0x${string}`,
  };
}

describe("pollFactoryOnce", () => {
  beforeEach(() => {
    vi.resetModules();
    state.cursors.clear();
    state.launches.clear();
    state.blocks.clear();
    state.getLogs.mockReset().mockResolvedValue([]);
    state.getBlockNumber.mockReset().mockResolvedValue(5_012n);
    state.getCode.mockReset().mockResolvedValue("0x1234");
    state.getBlock.mockReset().mockImplementation(({ blockNumber }: { blockNumber: bigint }) => {
      return Promise.resolve(state.blocks.get(blockNumber) ?? { timestamp: 1_800_000_000n + blockNumber });
    });
    process.env["DATABASE_URL"] = "postgres://example";
  });

  it("inserts two TokenCreated events across a single 1500-block chunk", async () => {
    state.getBlockNumber.mockResolvedValue(2_510n);
    state.cursors.set("poll-factory.factory_deploy_block", "1000");
    state.getLogs.mockResolvedValueOnce([tokenLog(1, 1_100n), tokenLog(2, 2_400n)]);

    const { pollFactoryOnce } = await import("./poll-factory");
    const result = await pollFactoryOnce();

    expect(result).toEqual({ scanned: 2, inserted: 2, toBlock: 2_498n });
    expect(state.launches.size).toBe(2);
    expect(state.cursors.get("poll-factory.last_processed_block")).toBe("2498");
  });

  it("skips an already-present launch via ON CONFLICT", async () => {
    state.cursors.set("poll-factory.factory_deploy_block", "1000");
    state.launches.set("0x0000000000000000000000000000000000000001", { tokenAddress: "existing" });
    state.getLogs.mockResolvedValueOnce([tokenLog(1, 1_100n), tokenLog(2, 1_200n)]);

    const { pollFactoryOnce } = await import("./poll-factory");
    const result = await pollFactoryOnce();

    expect(result.inserted).toBe(1);
    expect(state.launches.size).toBe(2);
  });

  it("is idempotent on a second invocation", async () => {
    state.cursors.set("poll-factory.factory_deploy_block", "1000");
    state.getLogs.mockResolvedValueOnce([tokenLog(1, 1_100n)]).mockResolvedValueOnce([]);

    const { pollFactoryOnce } = await import("./poll-factory");
    await expect(pollFactoryOnce()).resolves.toMatchObject({ scanned: 1, inserted: 1 });
    await expect(pollFactoryOnce()).resolves.toMatchObject({ scanned: 0, inserted: 0 });
    expect(state.launches.size).toBe(1);
    expect(state.cursors.get("poll-factory.last_processed_block")).toBe("5000");
  });

  it("does not advance past the last successful chunk when a later chunk fails", async () => {
    state.cursors.set("poll-factory.factory_deploy_block", "1000");
    state.getBlockNumber.mockResolvedValue(7_012n);
    state.getLogs.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("rpc range failed"));

    const { pollFactoryOnce } = await import("./poll-factory");
    await expect(pollFactoryOnce()).rejects.toThrow("rpc range failed");

    expect(state.cursors.get("poll-factory.last_processed_block")).toBe("2999");
  });
});
