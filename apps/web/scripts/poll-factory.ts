import { pathToFileURL } from "node:url";
import { Pool } from "@neondatabase/serverless";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import {
  createPublicClient,
  encodeEventTopics,
  getAddress,
  http,
  parseAbi,
  type Address,
} from "viem";
import { base } from "viem/chains";

// Concrete client bound to Base. Avoids the generic-default `PublicClient`
// import: viem's Base type adds a "deposit" tx variant that's invariant against
// the default Chain, so passing `client` between helpers triggers TS2345.
type BaseClient = ReturnType<typeof createPublicClient<ReturnType<typeof http>, typeof base>>;
import { cronCursors, factoryLaunches } from "../db/schema";
import { logError, logInfo, messageOf } from "../lib/log";

// Address of the agents-specific Liquid factory, set by operator once that
// contract deploys. The general Liquid factory at 0x04F1a284…77760 powers
// app.liquidprotocol.org/tokens (memecoins + autonomopoly bootstrap); watching
// it surfaces 2k+ irrelevant deploys per autonomopoly. We do NOT default to
// any factory — if `AGENTS_FACTORY_ADDRESS` is unset, both the manual CLI and
// the cron route exit no-op with a clear log line.
function resolveFactoryAddress(): Address | null {
  const raw = process.env["AGENTS_FACTORY_ADDRESS"];
  if (raw === undefined || raw.length === 0) return null;
  return getAddress(raw) as Address;
}

// Deploy block of FACTORY_ADDRESS on Base. If unknown at script-build time,
// resolve once via discoverFactoryDeployBlock() (see helper below) and persist
// the result into cron_cursors as "poll-factory.factory_deploy_block". On
// subsequent invocations, read from cron_cursors instead of re-discovering.
// Fallback constant if discovery and cursor are both unavailable: the script
// must throw rather than silently scan from block 0 (Base RPC log range limit
// is 2000 blocks).
const FACTORY_DEPLOY_BLOCK_CURSOR_KEY = "poll-factory.factory_deploy_block";
const LAST_PROCESSED_CURSOR_KEY = "poll-factory.last_processed_block";

// 12-block confirmation depth on Base (~24s at 2s block time). Trades latency
// for finality.
const CONFIRMATION_DEPTH = 12n;

// Base eth_getLogs limit per call.
const LOG_RANGE_LIMIT = 2000n;

const TOKEN_CREATED_ABI = parseAbi([
  "event TokenCreated(address msgSender, address indexed tokenAddress, address indexed tokenAdmin, string tokenImage, string tokenName, string tokenSymbol, string tokenMetadata, string tokenContext, int24 startingTick, address poolHook, bytes32 poolId, address pairedToken, address locker, address mevModule, uint256 extensionsSupply, address[] extensions)",
]);

// Verified at script start against viem's ABI encoder so selector drift fails loudly.
const TOKEN_CREATED_TOPIC = "0x9299d1d1a88d8e1abdc591ae7a167a6bc63a8f17d695804e9091ee33aa89fb67";

const computedTopic = encodeEventTopics({ abi: TOKEN_CREATED_ABI, eventName: "TokenCreated" })[0];
if (computedTopic !== TOKEN_CREATED_TOPIC) {
  throw new Error(
    `TokenCreated topic mismatch: expected ${TOKEN_CREATED_TOPIC}, got ${computedTopic}`,
  );
}

type Db = ReturnType<typeof drizzle>;
type TokenCreatedLog = Awaited<ReturnType<BaseClient["getLogs"]>>[number] & {
  args: {
    tokenAddress?: Address;
    tokenAdmin?: Address;
    tokenName?: string;
    tokenSymbol?: string;
  };
  blockNumber: bigint;
  transactionHash: `0x${string}`;
};

export type PollFactoryResult = { scanned: number; inserted: number; toBlock: bigint };

function requireDatabaseUrl(): string {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required; set it via Vercel Marketplace (Neon) or .env.local");
  }
  return databaseUrl;
}

async function readCursor(db: Db, key: string): Promise<bigint | null> {
  const rows = await db
    .select({ value: cronCursors.value })
    .from(cronCursors)
    .where(eq(cronCursors.key, key));
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

async function getFactoryDeployBlock(
  db: Db,
  client: BaseClient,
  factory: Address,
): Promise<bigint> {
  const stored = await readCursor(db, FACTORY_DEPLOY_BLOCK_CURSOR_KEY);
  if (stored !== null) {
    return stored;
  }
  const discovered = await discoverFactoryDeployBlock(client, factory);
  await writeCursor(db, FACTORY_DEPLOY_BLOCK_CURSOR_KEY, discovered);
  return discovered;
}

export async function pollFactoryOnce(): Promise<PollFactoryResult> {
  const t0 = Date.now();
  const factory = resolveFactoryAddress();
  if (factory === null) {
    logInfo("factory_poll.skip", { reason: "AGENTS_FACTORY_ADDRESS not set" });
    return { scanned: 0, inserted: 0, toBlock: 0n };
  }
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  const db = drizzle(pool, { schema: { factoryLaunches, cronCursors } });
  const client = createPublicClient({
    chain: base,
    transport: http(process.env["BASE_RPC_URL"] ?? "https://mainnet.base.org"),
  });

  try {
    const currentBlock = await client.getBlockNumber();
    const toBlock = currentBlock > CONFIRMATION_DEPTH ? currentBlock - CONFIRMATION_DEPTH : 0n;
    const factoryDeployBlock = await getFactoryDeployBlock(db, client, factory);
    const lastProcessed = await readCursor(db, LAST_PROCESSED_CURSOR_KEY);
    const fromBlock =
      lastProcessed === null
        ? factoryDeployBlock
        : maxBigInt(lastProcessed + 1n, factoryDeployBlock);

    if (fromBlock > toBlock) {
      logInfo("factory_poll.tick", {
        scanned: 0,
        inserted: 0,
        fromBlock: fromBlock.toString(),
        toBlock: toBlock.toString(),
        elapsedMs: Date.now() - t0,
      });
      return { scanned: 0, inserted: 0, toBlock };
    }

    let scanned = 0;
    let inserted = 0;
    for (let chunkFrom = fromBlock; chunkFrom <= toBlock; chunkFrom += LOG_RANGE_LIMIT) {
      const chunkTo = minBigInt(chunkFrom + LOG_RANGE_LIMIT - 1n, toBlock);
      const logs = (await client.getLogs({
        address: factory,
        event: TOKEN_CREATED_ABI[0],
        fromBlock: chunkFrom,
        toBlock: chunkTo,
      })) as TokenCreatedLog[];

      scanned += logs.length;
      if (logs.length > 0) {
        const rows = await buildFactoryLaunchRows(client, logs);
        const insertedRows = await db
          .insert(factoryLaunches)
          .values(rows)
          .onConflictDoNothing({ target: factoryLaunches.tokenAddress })
          .returning({ tokenAddress: factoryLaunches.tokenAddress });
        inserted += insertedRows.length;
      }
      await writeCursor(db, LAST_PROCESSED_CURSOR_KEY, chunkTo);
    }

    logInfo("factory_poll.tick", {
      scanned,
      inserted,
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
      elapsedMs: Date.now() - t0,
    });
    return { scanned, inserted, toBlock };
  } finally {
    await pool.end();
  }
}

async function buildFactoryLaunchRows(client: BaseClient, logs: TokenCreatedLog[]) {
  const blockCache = new Map<bigint, Date>();
  const rows = [];
  for (const log of logs) {
    const tokenAddress = log.args.tokenAddress;
    const tokenAdmin = log.args.tokenAdmin;
    if (tokenAddress === undefined || tokenAdmin === undefined) {
      throw new Error(`TokenCreated log missing indexed args at ${log.transactionHash}`);
    }
    let deployedAt = blockCache.get(log.blockNumber);
    if (deployedAt === undefined) {
      const block = await client.getBlock({ blockNumber: log.blockNumber });
      deployedAt = new Date(Number(block.timestamp) * 1000);
      blockCache.set(log.blockNumber, deployedAt);
    }
    rows.push({
      tokenAddress: getAddress(tokenAddress).toLowerCase(),
      deployerAddress: getAddress(tokenAdmin).toLowerCase(),
      tokenName: emptyToNull(log.args.tokenName),
      tokenSymbol: emptyToNull(log.args.tokenSymbol),
      blockNumber: Number(log.blockNumber),
      txHash: log.transactionHash,
      deployedAt,
      prelaunchStatus: "pending",
    });
  }
  return rows;
}

function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value.length === 0 ? null : value;
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export async function discoverFactoryDeployBlock(
  client: BaseClient,
  address: Address,
): Promise<bigint> {
  const currentBlock = await client.getBlockNumber();
  const latestCode = await client.getCode({ address, blockNumber: currentBlock });
  if (latestCode === undefined || latestCode === "0x") {
    throw new Error(`No code found for factory ${address} at latest block ${currentBlock}`);
  }
  let lo = 0n;
  let hi = currentBlock;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const code = await client.getCode({ address, blockNumber: mid });
    if (code !== undefined && code !== "0x") {
      hi = mid;
    } else {
      lo = mid + 1n;
    }
  }
  return lo;
}

function isDirectCliInvocation(): boolean {
  const scriptPath = process.argv[1];
  return scriptPath !== undefined && import.meta.url === pathToFileURL(scriptPath).href;
}

if (isDirectCliInvocation()) {
  loadDotenv({ path: ".env.local", quiet: true });
  pollFactoryOnce()
    .then((result) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ ...result, toBlock: result.toBlock.toString() }, null, 2));
    })
    .catch((err) => {
      logError("factory_poll.failed", { message: messageOf(err) });
      process.exit(1);
    });
}
