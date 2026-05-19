/**
 * One-shot historical backfill for Liquid Protocol factory TokenCreated events.
 *
 * Usage after copying into apps/web/scripts:
 *   pnpm exec tsx scripts/backfill-factory.ts
 *
 * Idempotent: this script never reads or advances poll-factory.last_processed_block.
 */
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

import { cronCursors, factoryLaunches } from "../db/schema";

loadDotenv({ path: ".env.local", quiet: true });

type BaseClient = ReturnType<typeof createPublicClient<ReturnType<typeof http>, typeof base>>;
type Db = ReturnType<typeof drizzle>;

const FACTORY_ADDRESS = "0x04F1a284168743759BE6554f607a10CEBdB77760" as const;
const FACTORY_DEPLOY_BLOCK_CURSOR_KEY = "poll-factory.factory_deploy_block";
const CONFIRMATION_DEPTH = 12n;
const LOG_RANGE_LIMIT = 2000n;

// SOURCE-OF-TRUTH: scripts/poll-factory.ts
const TOKEN_CREATED_ABI = parseAbi([
  "event TokenCreated(address msgSender, address indexed tokenAddress, address indexed tokenAdmin, string tokenImage, string tokenName, string tokenSymbol, string tokenMetadata, string tokenContext, int24 startingTick, address poolHook, bytes32 poolId, address pairedToken, address locker, address mevModule, uint256 extensionsSupply, address[] extensions)",
]);

// SOURCE-OF-TRUTH: scripts/poll-factory.ts
const TOKEN_CREATED_TOPIC = "0x9299d1d1a88d8e1abdc591ae7a167a6bc63a8f17d695804e9091ee33aa89fb67";

const computedTopic = encodeEventTopics({ abi: TOKEN_CREATED_ABI, eventName: "TokenCreated" })[0];
if (computedTopic !== TOKEN_CREATED_TOPIC) {
  throw new Error(
    `TokenCreated topic mismatch: expected ${TOKEN_CREATED_TOPIC}, got ${computedTopic}`,
  );
}

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

async function getFactoryDeployBlock(db: Db, client: BaseClient): Promise<bigint> {
  const stored = await readCursor(db, FACTORY_DEPLOY_BLOCK_CURSOR_KEY);
  if (stored !== null) {
    return stored;
  }

  const discovered = await discoverFactoryDeployBlock(client, FACTORY_ADDRESS);
  await writeCursor(db, FACTORY_DEPLOY_BLOCK_CURSOR_KEY, discovered);
  return discovered;
}

async function discoverFactoryDeployBlock(client: BaseClient, address: Address): Promise<bigint> {
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

async function main(): Promise<void> {
  const t0 = Date.now();
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  const db = drizzle(pool, { schema: { factoryLaunches, cronCursors } });
  const client = createPublicClient({
    chain: base,
    transport: http(process.env["BASE_RPC_URL"] ?? "https://mainnet.base.org"),
  });

  try {
    const factoryDeployBlock = await getFactoryDeployBlock(db, client);
    const currentBlock = await client.getBlockNumber();
    const toBlock = currentBlock > CONFIRMATION_DEPTH ? currentBlock - CONFIRMATION_DEPTH : 0n;

    let chunks = 0;
    let scanned = 0;
    let inserted = 0;

    if (factoryDeployBlock <= toBlock) {
      for (let chunkFrom = factoryDeployBlock; chunkFrom <= toBlock; chunkFrom += LOG_RANGE_LIMIT) {
        const chunkTo = minBigInt(chunkFrom + LOG_RANGE_LIMIT - 1n, toBlock);
        const logs = (await client.getLogs({
          address: FACTORY_ADDRESS,
          event: TOKEN_CREATED_ABI[0],
          fromBlock: chunkFrom,
          toBlock: chunkTo,
        })) as TokenCreatedLog[];

        chunks += 1;
        scanned += logs.length;

        let insertedThisChunk = 0;
        if (logs.length > 0) {
          const rows = await buildFactoryLaunchRows(client, logs);
          const insertedRows = await db
            .insert(factoryLaunches)
            .values(rows)
            .onConflictDoNothing({ target: factoryLaunches.tokenAddress })
            .returning({ tokenAddress: factoryLaunches.tokenAddress });
          insertedThisChunk = insertedRows.length;
          inserted += insertedThisChunk;
        }

        // eslint-disable-next-line no-console
        console.log(
          `[${chunkFrom}-${chunkTo}] scanned=${logs.length} inserted=${insertedThisChunk}`,
        );
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `done — chunks=${chunks}, scanned=${scanned}, inserted=${inserted}, elapsed=${Date.now() - t0}ms`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
