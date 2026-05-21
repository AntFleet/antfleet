// Verifies an on-chain USDC Transfer on Base before crediting a channel.
// The /deposit endpoint (synchronous fast path) calls this with a tx hash
// supplied by the agent; the scan-deposits cron (PR #3) calls into the
// same helpers from the event-log direction. Both paths converge on
// `creditChannelFromDeposit`, which enforces idempotency.

import { createPublicClient, http, parseEventLogs, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import {
  BASE_CHAIN_ID,
  DEPOSIT_MIN_CONFIRMATIONS,
  getBaseRpcUrl,
  USDC_BASE_ADDRESS,
  USDC_DECIMALS,
} from "./env";

// Minimal ABI fragment — only the Transfer event matters for parsing logs.
const USDC_TRANSFER_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

export type VerifiedDeposit = {
  txHash: string;
  chainId: number;
  fromAddress: string;
  amountUsdc: string;
  blockNumber: number;
};

export type DepositVerifierDeps = {
  // Injected so tests can stub viem without touching the network. The
  // signatures intentionally mirror viem's PublicClient methods.
  getTransactionReceipt: (args: { hash: Hex }) => Promise<{
    status: "success" | "reverted";
    from: Address;
    to: Address | null;
    blockNumber: bigint;
    logs: Array<{ address: Address; topics: readonly Hex[]; data: Hex }>;
  }>;
  getBlockNumber: () => Promise<bigint>;
};

export function defaultDepositVerifierDeps(): DepositVerifierDeps {
  const client = createPublicClient({
    chain: base,
    transport: http(getBaseRpcUrl()),
  });
  return {
    getTransactionReceipt: (args) =>
      client.getTransactionReceipt({ hash: args.hash }) as ReturnType<
        DepositVerifierDeps["getTransactionReceipt"]
      >,
    getBlockNumber: () => client.getBlockNumber(),
  };
}

export type VerifyDepositError =
  | { code: "tx_not_found"; message: string }
  | { code: "tx_reverted"; message: string }
  | { code: "insufficient_confirmations"; message: string; needed: number; observed: number }
  | { code: "no_matching_transfer"; message: string }
  | { code: "amount_below_minimum"; message: string; observed: string; minimum: string }
  | { code: "sender_mismatch"; message: string };

export async function verifyDeposit(
  deps: DepositVerifierDeps,
  args: {
    txHash: string;
    expectedFrom: string;
    depositAddress: string;
    minDepositUsdc: string;
  },
): Promise<{ ok: true; deposit: VerifiedDeposit } | { ok: false; error: VerifyDepositError }> {
  let receipt: Awaited<ReturnType<DepositVerifierDeps["getTransactionReceipt"]>>;
  try {
    receipt = await deps.getTransactionReceipt({ hash: args.txHash as Hex });
  } catch {
    return { ok: false, error: { code: "tx_not_found", message: "transaction not found on Base" } };
  }
  if (receipt.status !== "success") {
    return { ok: false, error: { code: "tx_reverted", message: "transaction reverted" } };
  }

  const latest = await deps.getBlockNumber();
  const confirmations = Number(latest - receipt.blockNumber) + 1;
  if (confirmations < DEPOSIT_MIN_CONFIRMATIONS) {
    return {
      ok: false,
      error: {
        code: "insufficient_confirmations",
        message: `need ${DEPOSIT_MIN_CONFIRMATIONS} confirmations, observed ${confirmations}`,
        needed: DEPOSIT_MIN_CONFIRMATIONS,
        observed: confirmations,
      },
    };
  }

  const expectedFromLc = args.expectedFrom.toLowerCase();
  const depositLc = args.depositAddress.toLowerCase();
  const usdcLc = USDC_BASE_ADDRESS.toLowerCase();

  const transferLogs = parseEventLogs({
    abi: USDC_TRANSFER_ABI,
    logs: receipt.logs.filter((log) => log.address.toLowerCase() === usdcLc),
    eventName: "Transfer",
  });

  const matching = transferLogs.find(
    (log) =>
      log.args.from.toLowerCase() === expectedFromLc && log.args.to.toLowerCase() === depositLc,
  );
  if (matching === undefined) {
    // Distinguish "wrong sender" from "no USDC Transfer to deposit address
    // at all" so the agent can act on the message. Receipt.from is the EOA
    // that submitted the tx; for a typical wallet sending USDC it equals
    // the Transfer log's `from`.
    const anyToDeposit = transferLogs.some((log) => log.args.to.toLowerCase() === depositLc);
    if (anyToDeposit) {
      return {
        ok: false,
        error: {
          code: "sender_mismatch",
          message: "USDC Transfer to deposit address is not from the bound wallet",
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "no_matching_transfer",
        message: "no USDC Transfer to the AntFleet deposit address found in this transaction",
      },
    };
  }

  const amountUsdc = formatUsdcUnits(matching.args.value);
  if (compareUsdcStrings(amountUsdc, args.minDepositUsdc) < 0) {
    return {
      ok: false,
      error: {
        code: "amount_below_minimum",
        message: `deposit of ${amountUsdc} USDC is below minimum ${args.minDepositUsdc} USDC`,
        observed: amountUsdc,
        minimum: args.minDepositUsdc,
      },
    };
  }

  return {
    ok: true,
    deposit: {
      txHash: args.txHash.toLowerCase(),
      chainId: BASE_CHAIN_ID,
      fromAddress: matching.args.from.toLowerCase(),
      amountUsdc,
      blockNumber: Number(receipt.blockNumber),
    },
  };
}

// Converts a raw USDC base-unit bigint (6 decimals) to a fixed-point
// string matching the numeric(18,6) column. Avoids floats so 0.000001 USDC
// is representable.
export function formatUsdcUnits(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const divisor = 10n ** BigInt(USDC_DECIMALS);
  const whole = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(USDC_DECIMALS, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

// Compares two USDC fixed-point strings without losing precision. Returns
// negative if a < b, 0 if equal, positive if a > b.
export function compareUsdcStrings(a: string, b: string): number {
  const aUnits = parseUsdcUnits(a);
  const bUnits = parseUsdcUnits(b);
  if (aUnits < bUnits) return -1;
  if (aUnits > bUnits) return 1;
  return 0;
}

export function parseUsdcUnits(value: string): bigint {
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  const parts = body.split(".");
  if (parts.length > 2) {
    throw new Error(`invalid USDC amount: ${value}`);
  }
  const [wholePart, fractionPart = ""] = parts;
  if (wholePart === undefined || !/^\d+$/.test(wholePart) || !/^\d*$/.test(fractionPart)) {
    throw new Error(`invalid USDC amount: ${value}`);
  }
  const padded = (fractionPart + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  const units = BigInt(wholePart) * 10n ** BigInt(USDC_DECIMALS) + BigInt(padded);
  return negative ? -units : units;
}
