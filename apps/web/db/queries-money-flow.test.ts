// Real-Postgres money-movement test suite (audit T0.2).
//
// Boots a throwaway PostgreSQL container via @testcontainers/postgresql,
// replays every SQL file in db/migrations/ in lexicographic order so the
// schema matches prod head, then drives the four money-movement code paths
// against the live container:
//
//   1. creditChannelFromDeposit — deposit credit (no double-credit on
//      replayed tx hash, balance bumps once, install transitions to active).
//   2. debitChannel — per-review CAS (`WHERE balance >= price`) blocks
//      overdrafts under contention; mutating the WHERE makes the test fail
//      (verified locally as part of audit T0.2 — see report).
//   3. enqueueReview — `ON CONFLICT (repo_hash, pr_number, commit_sha)
//      DO NOTHING` dedupes duplicate webhook deliveries; the second call
//      returns the existing reviewId with isNew=false.
//   4. claimReviewForProcessing — Postgres row-level lock means exactly
//      one of two concurrent claims wins.
//
// Tests skip when Docker is unavailable (matches the 0028.test.ts pattern),
// so local runs without a daemon stay green; CI has Docker so the suite runs
// in the cloud. NEVER hits the real DATABASE_URL — we mock the db singleton
// via vi.mock("./index", ...) so even the singleton-using paths
// (enqueueReview, claimReviewForProcessing) talk to the container only.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// We hoist a mutable holder so vi.mock can give every importer of "./index"
// the same drizzle client we wire up inside beforeAll. The holder is empty
// at module load; tests that touch the db before beforeAll runs will throw
// loudly (which is what we want).
const dbHolder = vi.hoisted(() => ({
  current: null as unknown,
}));

vi.mock("./index", async () => {
  // schema is a plain table-definition module — safe to import eagerly.
  // The db export is a getter so vitest's module cache resolves it lazily,
  // after beforeAll has installed the live client.
  const schemaModule = await import("./schema");
  return {
    get db() {
      if (dbHolder.current === null) {
        throw new Error("db holder not initialized — beforeAll() did not run");
      }
      return dbHolder.current;
    },
    schema: schemaModule,
  };
});

// Importing AFTER the vi.mock declaration so the mock factory wins.
// queries.ts does `import { db } from "./index";` — vitest matches the
// resolved path, so the mock above intercepts it.
const queriesModule = await import("./queries");
const paywallQueries = await import("../lib/paywall/queries");
const paywallGate = await import("../lib/paywall/gate");

const {
  enqueueReview,
  claimReviewForProcessing,
  hashRepo,
}: {
  enqueueReview: typeof import("./queries").enqueueReview;
  claimReviewForProcessing: typeof import("./queries").claimReviewForProcessing;
  hashRepo: typeof import("./queries").hashRepo;
} = queriesModule;
const { creditChannelFromDeposit } = paywallQueries;
const { debitChannel } = paywallGate;

function hasDocker(): boolean {
  const result = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return result.status === 0;
}

const describeWithDocker = hasDocker() ? describe : describe.skip;

// Replay every migration file in lexicographic order. We deliberately use
// the FULL list (not a hand-picked subset like 0028.test.ts) so the schema
// matches prod HEAD — the four queries under test depend on tables and
// columns added across many migrations.
function loadMigrationFiles(): Array<{ name: string; sql: string }> {
  const dir = join(__dirname, "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .toSorted();
  return files.map((name) => ({
    name,
    sql: readFileSync(join(dir, name), "utf8"),
  }));
}

async function applyAllMigrations(client: Sql): Promise<void> {
  // Migrations include DO $$ ... $$ blocks (e.g. 0035) whose bodies
  // contain semicolons. postgres-js's `.unsafe(text).simple()` runs the
  // text via the Postgres simple-query protocol, which parses statement
  // boundaries server-side and handles DO blocks correctly.
  const files = loadMigrationFiles();
  for (const file of files) {
    try {
      await client.unsafe(file.sql).simple();
    } catch (err) {
      throw new Error(
        `migration ${file.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
}

// Fixture for a RecordReviewInput — the not-null shape that enqueueReview /
// recordReview require. Mirrors the producer in lib/review-job-worker.ts so
// changes there should also update this.
function makeReviewInput(overrides: {
  repoHash: string;
  prNumber: number;
  commitSha: string;
}): Parameters<typeof enqueueReview>[0] {
  return {
    repoHash: overrides.repoHash,
    prNumber: overrides.prNumber,
    commitSha: overrides.commitSha,
    filesReviewed: [],
    promptVersion: "test-v1",
    providerModelIds: {},
    providerResponses: { status: "pending" },
    agreementDecision: { status: "pending" },
    timingMs: 0,
    costEstimatedUsd: 0,
    schemaVersion: 1,
    installationId: 12345,
    owner: "antfleet",
    repo: "fixture",
    publicReceipt: false,
    isBenchmark: false,
  };
}

// Insert an installation + channel row and return both ids. Used by the
// deposit and debit suites — both functions need a real (installation,
// channel) pair so the constraint chain (installations.id → channels.id →
// payments.channel_id) resolves.
async function seedInstallationWithChannel(
  client: Sql,
  args: { walletAddress: string; initialBalanceUsdc: string },
): Promise<{ installationRowId: string; channelId: string }> {
  const [installRow] = await client<{ id: string }[]>`
    INSERT INTO installations (status, wallet_address)
    VALUES ('awaiting_deposit', ${args.walletAddress.toLowerCase()})
    RETURNING id
  `;
  if (!installRow) throw new Error("installation insert returned no row");
  const [channelRow] = await client<{ id: string }[]>`
    INSERT INTO channels (installation_id, wallet_address, balance_usdc)
    VALUES (
      ${installRow.id},
      ${args.walletAddress.toLowerCase()},
      ${args.initialBalanceUsdc}
    )
    RETURNING id
  `;
  if (!channelRow) throw new Error("channel insert returned no row");
  return { installationRowId: installRow.id, channelId: channelRow.id };
}

// Container boot + migration replay is the slowest part of the suite (~15s
// locally). Share ONE container across all four describes by hoisting it to
// a top-level beforeAll/afterAll. Each test seeds its own rows under a
// distinct repo_hash / wallet so there's no cross-test interference.
describeWithDocker("money-movement SQL against real Postgres", () => {
  let container: StartedPostgreSqlContainer | undefined;
  let client: Sql | undefined;
  // Strongly-typed handle on the drizzle client. We don't constrain its
  // generic because the queries.ts code paths only call .update/.insert/
  // .select with the schema bound at queries.ts's import site.
  // biome-ignore lint/suspicious/noExplicitAny: drizzle's typed generic adds no test value
  let drizzleClient: any;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("antfleet_test")
      .withUsername("antfleet")
      .withPassword("antfleet")
      .start();
    client = postgres(container.getConnectionUri(), {
      max: 5,
      onnotice: () => {
        // Suppress NOTICE-level messages from migration replay
        // (e.g. "relation already exists" inside DO blocks). Errors still
        // throw normally — onnotice only catches non-fatal server messages.
      },
    });
    await applyAllMigrations(client);
    const schemaModule = await import("./schema");
    drizzleClient = drizzle(client, { schema: schemaModule });
    dbHolder.current = drizzleClient;
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  describe("creditChannelFromDeposit", () => {
    it("credits the channel once and is idempotent on replayed tx hash", async () => {
      if (!client) throw new Error("client not initialized");
      const wallet = "0x1111111111111111111111111111111111111111";
      const { channelId, installationRowId } = await seedInstallationWithChannel(client, {
        walletAddress: wallet,
        initialBalanceUsdc: "0",
      });
      const txHash = `0x${"a".repeat(64)}`;
      const args = {
        channelId,
        txHash,
        chainId: 8453,
        fromAddress: wallet,
        amountUsdc: "5.000000",
        blockNumber: 100,
      };

      const firstCredit = await creditChannelFromDeposit(drizzleClient, args);
      expect(firstCredit).toBe(true);

      const secondCredit = await creditChannelFromDeposit(drizzleClient, args);
      expect(secondCredit).toBe(false);

      // Real-DB assertion: balance bumped EXACTLY once despite two calls.
      // If the ON CONFLICT predicate is removed (or the partial index match
      // breaks), the second insert would either throw or double-credit —
      // this assertion is what catches the regression.
      const [balanceRow] = await client<{ balance_usdc: string }[]>`
        SELECT balance_usdc::text AS balance_usdc FROM channels WHERE id = ${channelId}
      `;
      expect(balanceRow?.balance_usdc).toBe("5.000000");

      // One payment row of type='deposit' for the (chain_id, tx_hash) pair.
      const [paymentCount] = await client<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM payments
        WHERE channel_id = ${channelId} AND type = 'deposit' AND tx_hash = ${txHash}
      `;
      expect(paymentCount?.n).toBe(1);

      const [installRow] = await client<{ status: string }[]>`
        SELECT status FROM installations WHERE id = ${installationRowId}
      `;
      expect(installRow?.status).toBe("active");
    });
  });

  describe("debitChannel CAS (WHERE balance >= price)", () => {
    it("debits when balance suffices and refuses when it does not", async () => {
      if (!client) throw new Error("client not initialized");
      const wallet = "0x2222222222222222222222222222222222222222";
      const { channelId } = await seedInstallationWithChannel(client, {
        walletAddress: wallet,
        initialBalanceUsdc: "10.000000",
      });

      // Sufficient — debit succeeds, balance drops by exactly the price.
      const okDebit = await debitChannel(drizzleClient, {
        channelId,
        priceUsdc: "3.000000",
      });
      expect(okDebit).not.toBeNull();
      expect(okDebit?.newBalanceUsdc).toBe("7.000000");

      // Drain to near-empty so the next debit must trip the CAS.
      const drain = await debitChannel(drizzleClient, {
        channelId,
        priceUsdc: "6.500000",
      });
      expect(drain?.newBalanceUsdc).toBe("0.500000");

      // Insufficient — the CAS predicate (balance_usdc >= price_usdc::numeric)
      // matches 0 rows, the UPDATE returns nothing, debitChannel returns null,
      // and the balance is unchanged. Mutating the WHERE to `>= 0` would
      // remove the guard and let this overdraft through — the audit run
      // verified this locally as the mutation test required by T0.2.
      const overdraft = await debitChannel(drizzleClient, {
        channelId,
        priceUsdc: "5.000000",
      });
      expect(overdraft).toBeNull();

      const [balanceRow] = await client<{ balance_usdc: string }[]>`
        SELECT balance_usdc::text AS balance_usdc FROM channels WHERE id = ${channelId}
      `;
      expect(balanceRow?.balance_usdc).toBe("0.500000");
    });

    it("never overdrafts under concurrent debits — at most one of two competing claims succeeds", async () => {
      if (!client) throw new Error("client not initialized");
      const wallet = "0x3333333333333333333333333333333333333333";
      const { channelId } = await seedInstallationWithChannel(client, {
        walletAddress: wallet,
        initialBalanceUsdc: "1.000000",
      });

      // Two parallel debits at price=1 against a balance=1 channel. Without
      // the WHERE guard both could land. With the guard, the row lock means
      // exactly one wins; the loser sees newBalanceUsdc=null.
      const [a, b] = await Promise.all([
        debitChannel(drizzleClient, { channelId, priceUsdc: "1.000000" }),
        debitChannel(drizzleClient, { channelId, priceUsdc: "1.000000" }),
      ]);
      const winners = [a, b].filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.newBalanceUsdc).toBe("0.000000");

      const [balanceRow] = await client<{ balance_usdc: string }[]>`
        SELECT balance_usdc::text AS balance_usdc FROM channels WHERE id = ${channelId}
      `;
      expect(balanceRow?.balance_usdc).toBe("0.000000");
    });
  });

  describe("enqueueReview ON CONFLICT dedupe", () => {
    it("returns the existing reviewId with isNew=false on duplicate (repoHash, prNumber, commitSha)", async () => {
      const input = makeReviewInput({
        repoHash: hashRepo("antfleet", "enqueue-dedupe"),
        prNumber: 42,
        commitSha: "deadbeef".repeat(5),
      });

      const first = await enqueueReview(input);
      expect(first.isNew).toBe(true);

      const second = await enqueueReview(input);
      expect(second.isNew).toBe(false);
      // Same row — the conflict path read the existing reviewId rather
      // than minting a new one. If the unique index name or column triple
      // ever drifts, this assertion goes red.
      expect(second.reviewId).toBe(first.reviewId);

      if (!client) throw new Error("client not initialized");
      const [reviewCount] = await client<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM reviews
        WHERE repo_hash = ${input.repoHash}
          AND pr_number = ${input.prNumber}
          AND commit_sha = ${input.commitSha}
      `;
      expect(reviewCount?.n).toBe(1);
    });
  });

  describe("claimReviewForProcessing single-winner", () => {
    it("exactly one of two concurrent claims succeeds; the loser sees false", async () => {
      const input = makeReviewInput({
        repoHash: hashRepo("antfleet", "claim-race"),
        prNumber: 7,
        commitSha: "feedface".repeat(5),
      });
      const enqueued = await enqueueReview(input);
      expect(enqueued.isNew).toBe(true);

      const now = new Date();
      // Two parallel claims from the same starting state ("pending"). The
      // Postgres row lock obtained by the first UPDATE blocks the second
      // until the first commits; the second then re-evaluates its WHERE
      // (processing_status IN ('pending')) against the post-commit state,
      // sees 'in_progress', and matches 0 rows.
      const [a, b] = await Promise.all([
        claimReviewForProcessing({
          reviewId: enqueued.reviewId,
          fromStatuses: ["pending"],
          now,
        }),
        claimReviewForProcessing({
          reviewId: enqueued.reviewId,
          fromStatuses: ["pending"],
          now,
        }),
      ]);
      const wins = [a, b].filter(Boolean);
      expect(wins).toHaveLength(1);

      if (!client) throw new Error("client not initialized");
      const [row] = await client<
        {
          processing_status: string;
          processing_attempts: number;
        }[]
      >`
        SELECT processing_status, processing_attempts
        FROM reviews
        WHERE review_id = ${enqueued.reviewId}
      `;
      expect(row?.processing_status).toBe("in_progress");
      // processing_attempts incremented exactly once — confirms only one
      // UPDATE actually mutated the row.
      expect(row?.processing_attempts).toBe(1);
    });
  });
});
