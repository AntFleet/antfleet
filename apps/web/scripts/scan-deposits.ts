// Safety-net for the /deposit fast path. The synchronous endpoint credits a
// channel within seconds when an agent POSTs its tx hash; this cron exists
// for the case where an agent sends USDC but never calls /deposit (eg the
// agent crashed between sending and POSTing, or it doesn't know to POST at
// all). Both paths converge on `creditChannelFromDeposit`, which enforces
// idempotency via the partial unique index on payments(chain_id, tx_hash) —
// so observing the same Transfer twice is harmless.
//
// Algorithm:
//   1. Read last scanned block from cron_cursors.
//   2. Get current block; compute toBlock = current - CONFIRMATION_DEPTH + 1.
//   3. eth_getLogs for USDC Transfer events with `to` = depositAddress, in
//      [fromBlock, toBlock], chunked at 2000 blocks (Base RPC limit).
//   4. For each log, look up the channel by `wallet_address = log.from`. If
//      found, INSERT into payments ON CONFLICT DO NOTHING + bump the
//      channel balance.
//   5. Advance the cursor to chunkTo after each chunk so partial progress
//      survives RPC failures mid-tick.

import { pathToFileURL } from "node:url";
import { Pool } from "@neondatabase/serverless";
import { config as loadDotenv } from "dotenv";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import { createPublicClient, encodeEventTopics, getAddress, http, parseAbi, type Address } from "viem";
import { base } from "viem/chains";
import { channels, cronCursors, payments } from "../db/schema";
import { logError, logInfo, messageOf } from "../lib/log";
import {
  BASE_CHAIN_ID,
  DEPOSIT_MIN_CONFIRMATIONS,
  getBaseRpcUrl,
  getDepositAddress,
  USDC_BASE_ADDRESS,
  USDC_DECIMALS,
} from "../lib/paywall/env";

type BaseClient = ReturnType<typeof createPublicClient<ReturnType<typeof http>, typeof base>>;
type Db = ReturnType<typeof drizzle>;

const LAST_PROCESSED_CURSOR_KEY = "scan-deposits.last_processed_block";
// USDC on Base launched at block 5_086_768 (timestamp 2023-08-09). Cold cursor
// → start scanning from this anchor rather than 0 so we don't burn 5M empty
// chunks. Operator can override by setting the cursor manually.
const USDC_DEPLOY_BLOCK_FALLBACK = 5_086_768n;

const TRANSFER_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const computedTopic = encodeEventTopics({ abi: TRANSFER_ABI, eventName: "Transfer" })[0];
if (computedTopic !== TRANSFER_TOPIC) {
  throw new Error(`Transfer topic mismatch: expected ${TRANSFER_TOPIC}, got ${computedTopic}`);
}

const LOG_RANGE_LIMIT = 2000n;
const CONFIRMATION_DEPTH = BigInt(DEPOSIT_MIN_CONFIRMATIONS);

export type TransferLog = {
  from: string;
  to: string;
  value: bigint;
  blockNumber: bigint;
  txHash: string;
};

export type ChannelRow = { id: string; walletAddress: string };

export type ScanDepositsResult = {
  scanned: number;
  credited: number;
  alreadyCredited: number;
  unmatched: number;
  fromBlock: string;
  toBlock: string;
};

export type ScanDepositsDeps = {
  getCurrentBlock: () => Promise<bigint>;
  getLogs: (args: { fromBlock: bigint; toBlock: bigint }) => Promise<TransferLog[]>;
  readCursor: () => Promise<bigint | null>;
  writeCursor: (block: bigint) => Promise<void>;
  loadChannelByWallet: (walletAddress: string) => Promise<ChannelRow | null>;
  creditDeposit: (args: {
    channelId: string;
    txHash: string;
    fromAddress: string;
    amountUsdc: string;
    blockNumber: number;
  }) => Promise<boolean>;
};

export async function scanDepositsOnce(): Promise<ScanDepositsResult | { skipped: string }> {
  const depositAddress = getDepositAddress();
  if (depositAddress === null) {
    logInfo("scan_deposits.skip", { reason: "ANTFLEET_DEPOSIT_ADDRESS not set" });
    return { skipped: "deposit_address_unconfigured" };
  }
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required; set it via Vercel Marketplace (Neon) or .env.local");
  }
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema: { channels, cronCursors, payments } });
  const client = createPublicClient({
    chain: base,
    transport: http(getBaseRpcUrl()),
  });
  try {
    return await scanDepositsWithDeps(buildLiveDeps(db, client, depositAddress));
  } finally {
    await pool.end();
  }
}

export function buildLiveDeps(db: Db, client: BaseClient, depositAddress: string): ScanDepositsDeps {
  const depositLc = depositAddress.toLowerCase();
  return {
    getCurrentBlock: () => client.getBlockNumber(),
    async getLogs({ fromBlock, toBlock }) {
      const logs = await client.getLogs({
        address: USDC_BASE_ADDRESS as Address,
        event: TRANSFER_ABI[0],
        args: { to: depositLc as Address },
        fromBlock,
        toBlock,
      });
      const out: TransferLog[] = [];
      for (const log of logs) {
        const from = log.args.from;
        const value = log.args.value;
        if (from === undefined || value === undefined) continue;
        out.push({
          from: getAddress(from).toLowerCase(),
          to: depositLc,
          value,
          blockNumber: log.blockNumber,
          txHash: log.transactionHash.toLowerCase(),
        });
      }
      return out;
    },
    readCursor: () => readCursor(db, LAST_PROCESSED_CURSOR_KEY),
    writeCursor: (block) => writeCursor(db, LAST_PROCESSED_CURSOR_KEY, block),
    loadChannelByWallet: (wallet) => loadChannelByWallet(db, wallet),
    creditDeposit: (args) => creditDeposit(db, args),
  };
}

export async function scanDepositsWithDeps(deps: ScanDepositsDeps): Promise<ScanDepositsResult> {
  const t0 = Date.now();
  const currentBlock = await deps.getCurrentBlock();
  const toBlock =
    currentBlock + 1n > CONFIRMATION_DEPTH ? currentBlock - CONFIRMATION_DEPTH + 1n : 0n;
  const lastProcessed = await deps.readCursor();
  const fromBlock = lastProcessed === null ? USDC_DEPLOY_BLOCK_FALLBACK : lastProcessed + 1n;

  if (fromBlock > toBlock) {
    logInfo("scan_deposits.tick", {
      scanned: 0,
      credited: 0,
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
      elapsedMs: Date.now() - t0,
    });
    return {
      scanned: 0,
      credited: 0,
      alreadyCredited: 0,
      unmatched: 0,
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
    };
  }

  let scanned = 0;
  let credited = 0;
  let alreadyCredited = 0;
  let unmatched = 0;

  for (let chunkFrom = fromBlock; chunkFrom <= toBlock; chunkFrom += LOG_RANGE_LIMIT) {
    const chunkTo = minBigInt(chunkFrom + LOG_RANGE_LIMIT - 1n, toBlock);
    const logs = await deps.getLogs({ fromBlock: chunkFrom, toBlock: chunkTo });
    scanned += logs.length;
    for (const log of logs) {
      const channel = await deps.loadChannelByWallet(log.from);
      if (channel === null) {
        unmatched += 1;
        continue;
      }
      const amountUsdc = formatUsdcUnits(log.value);
      const wasFirstObservation = await deps.creditDeposit({
        channelId: channel.id,
        txHash: log.txHash,
        fromAddress: log.from,
        amountUsdc,
        blockNumber: Number(log.blockNumber),
      });
      if (wasFirstObservation) credited += 1;
      else alreadyCredited += 1;
    }
    await deps.writeCursor(chunkTo);
  }

  const result: ScanDepositsResult = {
    scanned,
    credited,
    alreadyCredited,
    unmatched,
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
  };
  logInfo("scan_deposits.tick", { ...result, elapsedMs: Date.now() - t0 });
  return result;
}

async function readCursor(db: Db, key: string): Promise<bigint | null> {
  const rows = await db.select({ value: cronCursors.value }).from(cronCursors).where(eq(cronCursors.key, key));
  const value = rows[0]?.value;
  return value === undefined ? null : BigInt(value);
}

async function writeCursor(db: Db, key: string, value: bigint): Promise<void> {
  await db
    .insert(cronCursors)
    .values({ key, value: value.toString() })
    .onConflictDoUpdate({
      target: cronCursors.key,
      set: { value: value.toString() },
    });
}

async function loadChannelByWallet(db: Db, walletAddress: string): Promise<ChannelRow | null> {
  // Most recently created channel for the wallet — agent flow is
  // one-wallet-per-installation so this is unambiguous. The unique constraint
  // is on channels(installation_id), not (wallet_address), to keep the
  // wallet-reputation page able to aggregate across installations.
  const result = await db.execute(sql`
    SELECT id, wallet_address AS "walletAddress"
    FROM channels
    WHERE wallet_address = ${walletAddress}
    ORDER BY created_at DESC
    LIMIT 1
  `);
  return firstRow<ChannelRow>(result);
}

async function creditDeposit(
  db: Db,
  args: {
    channelId: string;
    txHash: string;
    fromAddress: string;
    amountUsdc: string;
    blockNumber: number;
  },
): Promise<boolean> {
  const insertResult = await db.execute(sql`
    INSERT INTO payments (channel_id, type, tx_hash, chain_id, from_address, amount_usdc, block_number)
    VALUES (
      ${args.channelId},
      'deposit',
      ${args.txHash},
      ${BASE_CHAIN_ID},
      ${args.fromAddress},
      ${args.amountUsdc},
      ${args.blockNumber}
    )
    ON CONFLICT (chain_id, tx_hash) DO NOTHING
    RETURNING id
  `);
  const inserted = firstRow<{ id: string }>(insertResult);
  if (inserted === null) return false;
  await db.execute(sql`
    UPDATE channels
    SET
      balance_usdc = balance_usdc + ${args.amountUsdc}::numeric,
      last_deposit_tx_hash = ${args.txHash}
    WHERE id = ${args.channelId}
  `);
  return true;
}

function formatUsdcUnits(value: bigint): string {
  const divisor = 10n ** BigInt(USDC_DECIMALS);
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(USDC_DECIMALS, "0");
  return `${whole.toString()}.${fraction}`;
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function firstRow<T>(result: unknown): T | null {
  const rows = Array.isArray(result)
    ? result
    : Array.isArray((result as { rows?: unknown[] }).rows)
      ? (result as { rows: unknown[] }).rows
      : [];
  return (rows[0] as T | undefined) ?? null;
}

function isDirectCliInvocation(): boolean {
  const scriptPath = process.argv[1];
  return scriptPath !== undefined && import.meta.url === pathToFileURL(scriptPath).href;
}

if (isDirectCliInvocation()) {
  loadDotenv({ path: ".env.local", quiet: true });
  scanDepositsOnce()
    .then((result) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      logError("scan_deposits.failed", { message: messageOf(err) });
      process.exit(1);
    });
}
