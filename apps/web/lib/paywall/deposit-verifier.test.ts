import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import {
  compareUsdcStrings,
  formatUsdcUnits,
  parseUsdcUnits,
  verifyDeposit,
  type DepositVerifierDeps,
} from "./deposit-verifier";
import { USDC_BASE_ADDRESS } from "./env";

const WALLET = "0x1111111111111111111111111111111111111111";
const DEPOSIT = "0x2222222222222222222222222222222222222222";
const TX_HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function transferLog(args: { from: string; to?: string; value: bigint; address?: string }): {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
} {
  return {
    address: (args.address ?? USDC_BASE_ADDRESS) as Address,
    topics: [
      TRANSFER_TOPIC,
      `0x000000000000000000000000${args.from.slice(2)}`,
      `0x000000000000000000000000${(args.to ?? DEPOSIT).slice(2)}`,
    ] as readonly Hex[],
    data: `0x${args.value.toString(16).padStart(64, "0")}` as Hex,
  };
}

function deps(
  logs: Array<{ address: Address; topics: readonly Hex[]; data: Hex }>,
  overrides: Partial<DepositVerifierDeps> = {},
): DepositVerifierDeps {
  return {
    getTransactionReceipt: async () => ({
      status: "success",
      from: WALLET as Address,
      to: USDC_BASE_ADDRESS as Address,
      blockNumber: 100n,
      logs,
    }),
    getBlockNumber: async () => 102n,
    ...overrides,
  };
}

describe("USDC fixed-point helpers", () => {
  it("formats whole-unit values", () => {
    expect(formatUsdcUnits(5_000_000n)).toBe("5.000000");
  });

  it("formats sub-unit values", () => {
    expect(formatUsdcUnits(1n)).toBe("0.000001");
  });

  it("formats zero", () => {
    expect(formatUsdcUnits(0n)).toBe("0.000000");
  });

  it("parses whole and fractional strings symmetrically", () => {
    for (const raw of [0n, 1n, 5_000_000n, 12_345_678_901_234n]) {
      expect(parseUsdcUnits(formatUsdcUnits(raw))).toBe(raw);
    }
  });

  it("compares fixed-point strings correctly", () => {
    expect(compareUsdcStrings("5.00", "5.000000")).toBe(0);
    expect(compareUsdcStrings("4.999999", "5.00")).toBeLessThan(0);
    expect(compareUsdcStrings("5.000001", "5.00")).toBeGreaterThan(0);
  });

  it("rejects malformed amounts", () => {
    expect(() => parseUsdcUnits("not-a-number")).toThrow();
    expect(() => parseUsdcUnits("5.0.0")).toThrow();
  });
});

describe("verifyDeposit", () => {
  it("credits the sum of all matching USDC transfers in one tx", async () => {
    const result = await verifyDeposit(
      deps([
        transferLog({ from: WALLET, value: 3_000_000n }),
        transferLog({ from: WALLET, value: 2_500_000n }),
      ]),
      {
        txHash: TX_HASH,
        expectedFrom: WALLET,
        depositAddress: DEPOSIT,
        minDepositUsdc: "5.00",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      deposit: {
        txHash: TX_HASH,
        fromAddress: WALLET,
        amountUsdc: "5.500000",
        blockNumber: 100,
      },
    });
  });

  it("applies the minimum deposit floor to the summed amount", async () => {
    const result = await verifyDeposit(
      deps([
        transferLog({ from: WALLET, value: 2_000_000n }),
        transferLog({ from: WALLET, value: 2_500_000n }),
      ]),
      {
        txHash: TX_HASH,
        expectedFrom: WALLET,
        depositAddress: DEPOSIT,
        minDepositUsdc: "5.00",
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "amount_below_minimum", observed: "4.500000", minimum: "5.00" },
    });
  });

  it("returns a retryable RPC error when the latest block read fails", async () => {
    const result = await verifyDeposit(
      deps([transferLog({ from: WALLET, value: 5_000_000n })], {
        getBlockNumber: async () => {
          throw new Error("rpc unavailable");
        },
      }),
      {
        txHash: TX_HASH,
        expectedFrom: WALLET,
        depositAddress: DEPOSIT,
        minDepositUsdc: "5.00",
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "rpc_unavailable" },
    });
  });
});
