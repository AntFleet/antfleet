// Real-Postgres test for loadAllTimeAgreementRate's SQL aggregate-pushdown
// (audit M6). The previous impl fanned reviews.provider_responses (two full
// frontier-model outputs each) into JS to sum finding counts; the new impl
// pushes it into a jsonb_array_length SUM in SQL. This suite drives the SQL
// against a live container and pins the semantic equivalence + the edge cases
// mocks can't catch (JSONB shape handling, gate interaction).
//
// Skips without Docker (matches queries-money-flow.test.ts); CI runs it.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dbHolder = vi.hoisted(() => ({
  current: null as unknown,
}));

vi.mock("./index", async () => {
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

const scorecardModule = await import("../lib/scorecard");
const { loadAllTimeAgreementRate } = scorecardModule;

function hasDocker(): boolean {
  const result = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return result.status === 0;
}

const describeWithDocker = hasDocker() ? describe : describe.skip;

async function applyAllMigrations(client: Sql): Promise<void> {
  const dir = join(__dirname, "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .toSorted();
  for (const name of files) {
    try {
      await client.unsafe(readFileSync(join(dir, name), "utf8")).simple();
    } catch (err) {
      throw new Error(
        `migration ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
}

function uuid(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

type ProviderOutput = { name: string; findings: unknown[] };

function providerResponses(providers: ProviderOutput[]): unknown {
  return {
    status: "ok",
    perProvider: providers.map((p) => ({
      name: p.name,
      ms: 100,
      output: { findings: p.findings, inspected: { files: [], symbols: [], notes: [] } },
    })),
  };
}

async function seedReview(args: {
  client: Sql;
  n: number;
  publicReceipt: boolean;
  providers: ProviderOutput[] | "skipped" | "malformed";
  postedFindings: number;
}): Promise<string> {
  const c = args.client;
  const reviewId = uuid(args.n);
  const responses =
    args.providers === "skipped"
      ? { status: "skipped" }
      : args.providers === "malformed"
        ? { status: "ok", perProvider: "not-an-array" }
        : providerResponses(args.providers);
  await c`
    INSERT INTO reviews (
      review_id, repo_hash, pr_number, commit_sha, files_reviewed, prompt_version,
      provider_model_ids, provider_responses, agreement_decision, timing_ms,
      cost_estimated_usd, schema_version, public_receipt
    ) VALUES (
      ${reviewId}, ${"hash-" + args.n}, 1, 'sha', ARRAY['a.ts'], 'v1',
      '{}'::jsonb, ${JSON.stringify(responses)}::jsonb, '{}'::jsonb, 100,
      0, 1, ${args.publicReceipt}
    )`;
  for (let i = 0; i < args.postedFindings; i++) {
    await c`
      INSERT INTO finding_status (
        review_id, finding_index, finding_id, title, severity, category, status, source
      ) VALUES (
        ${reviewId}, ${i}, ${`f-${args.n}-${i}`}, 'T', 'high', 'security', 'closed', 'consensus'
      )`;
  }
  return reviewId;
}

describeWithDocker("loadAllTimeAgreementRate SQL pushdown (real Postgres, audit M6)", () => {
  let container: StartedPostgreSqlContainer | undefined;
  let client: Sql | undefined;
  let db: PostgresJsDatabase;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    client = postgres(container.getConnectionUri(), { max: 4 });
    db = drizzle(client);
    dbHolder.current = db;
    await applyAllMigrations(client);
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it("sums anthropic+openai findings across public reviews, matches expected rate", async () => {
    // Two public reviews with mixed provider outputs:
    //   R1: anthropic=3, openai=5, codex=99 (should be ignored), 3 posted findings
    //   R2: anthropic=2, openai=2, 4 posted findings
    // Denominator = 3+5 + 2+2 = 12
    // Posted     = 3 + 4 = 7
    // Rate       = 7/12
    await seedReview({
      client: client!,
      n: 1,
      publicReceipt: true,
      providers: [
        { name: "anthropic", findings: Array.from({ length: 3 }, (_, i) => ({ title: `a${i}` })) },
        { name: "openai", findings: Array.from({ length: 5 }, (_, i) => ({ title: `o${i}` })) },
        { name: "codex", findings: Array.from({ length: 99 }, (_, i) => ({ title: `c${i}` })) },
      ],
      postedFindings: 3,
    });
    await seedReview({
      client: client!,
      n: 2,
      publicReceipt: true,
      providers: [
        { name: "anthropic", findings: Array.from({ length: 2 }, (_, i) => ({ title: `a${i}` })) },
        { name: "openai", findings: Array.from({ length: 2 }, (_, i) => ({ title: `o${i}` })) },
      ],
      postedFindings: 4,
    });

    const result = await loadAllTimeAgreementRate();
    expect(result).not.toBeNull();
    expect(result!.totalDistinctFindings).toBe(12);
    expect(result!.findingsPosted).toBe(7);
    expect(result!.rate).toBeCloseTo(7 / 12, 10);
  });

  it("tolerates skipped and malformed provider_responses shapes without throwing (denominator 0)", async () => {
    // Fresh container-scoped rows on top of the previous test. Skipped/malformed
    // reviews must contribute 0 to the denominator and not raise.
    await seedReview({
      client: client!,
      n: 3,
      publicReceipt: true,
      providers: "skipped",
      postedFindings: 0,
    });
    await seedReview({
      client: client!,
      n: 4,
      publicReceipt: true,
      providers: "malformed",
      postedFindings: 0,
    });

    // Still returns the same aggregate as before — the two edge rows added nothing.
    const result = await loadAllTimeAgreementRate();
    expect(result).not.toBeNull();
    expect(result!.totalDistinctFindings).toBe(12);
    expect(result!.findingsPosted).toBe(7);
  });

  it("tolerates entry-level malformed shapes (null output, non-array findings) without throwing", async () => {
    // Pin the entry-level typeof guards so a future author who drops
    // `jsonb_typeof(entry->'output'->'findings') = 'array'` gets a test failure.
    const c = client!;
    const reviewId = uuid(90);
    const perProvider = [
      { name: "anthropic", ms: 100, output: null }, // output is null
      { name: "openai", ms: 100, output: { findings: { bad: 1 } } }, // findings is an object, not an array
      { name: "anthropic", ms: 100, output: { findings: null } }, // findings is null
    ];
    await c`
      INSERT INTO reviews (
        review_id, repo_hash, pr_number, commit_sha, files_reviewed, prompt_version,
        provider_model_ids, provider_responses, agreement_decision, timing_ms,
        cost_estimated_usd, schema_version, public_receipt
      ) VALUES (
        ${reviewId}, 'hash-90', 1, 'sha', ARRAY['a.ts'], 'v1',
        '{}'::jsonb, ${JSON.stringify({ status: "ok", perProvider })}::jsonb,
        '{}'::jsonb, 100, 0, 1, true
      )`;

    // Adds 0 to the denominator, no throw.
    const result = await loadAllTimeAgreementRate();
    expect(result).not.toBeNull();
    expect(result!.totalDistinctFindings).toBe(12);
    expect(result!.findingsPosted).toBe(7);
  });

  it("excludes non-public reviews from both numerator and denominator", async () => {
    await seedReview({
      client: client!,
      n: 5,
      publicReceipt: false,
      providers: [
        {
          name: "anthropic",
          findings: Array.from({ length: 100 }, (_, i) => ({ title: `a${i}` })),
        },
        { name: "openai", findings: Array.from({ length: 100 }, (_, i) => ({ title: `o${i}` })) },
      ],
      postedFindings: 50,
    });

    // Non-public review must not budge the aggregate.
    const result = await loadAllTimeAgreementRate();
    expect(result).not.toBeNull();
    expect(result!.totalDistinctFindings).toBe(12);
    expect(result!.findingsPosted).toBe(7);
  });
});
