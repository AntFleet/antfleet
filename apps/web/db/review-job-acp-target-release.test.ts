// Real-Postgres ACP target-release test (audit M5 / #123 fix #4 completion).
//
// The unit tests (lib/review-job-queries.acp.test.ts) mock q.execute and pin the
// control flow. This suite verifies the behavior that mocks CANNOT: the actual
// partial unique index `idx_review_jobs_acp_target_key_unique` (from migration
// 0036) — which is NOT status-scoped — against a live container. It proves a
// target held by a terminally-failed job is released so it can be reviewed again,
// while an active/in-flight target still dedupes.
//
// Boots a throwaway PostgreSQL container, replays every db/migrations/*.sql in
// order so the schema matches prod head, then drives createAcpReviewJob against
// the live container. createAcpReviewJob takes an explicit Queryable, so we pass
// the drizzle client directly — no db-singleton mock needed. Skips when Docker is
// unavailable (matches queries-money-flow.test.ts); CI has Docker so it runs.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAcpReviewJob } from "../lib/review-job-queries";

function hasDocker(): boolean {
  const result = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return result.status === 0;
}

const describeWithDocker = hasDocker() ? describe : describe.skip;

function loadMigrationFiles(): Array<{ name: string; sql: string }> {
  const dir = join(__dirname, "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

async function applyAllMigrations(client: Sql): Promise<void> {
  for (const file of loadMigrationFiles()) {
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

const WALLET = "0x1111111111111111111111111111111111111111";
const SHA = "4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001";

function acpArgs(overrides: { acpJobId: string; targetKey: string; prNumber: number }) {
  return {
    acpJobId: overrides.acpJobId,
    clientAgentWallet: WALLET,
    repoOwner: "AntFleet",
    repoName: "acp-fixture",
    prNumber: overrides.prNumber,
    sha: SHA,
    requestPayload: {} as never,
    targetKey: overrides.targetKey,
  };
}

describeWithDocker("createAcpReviewJob target-key release (real Postgres)", () => {
  let container: StartedPostgreSqlContainer | undefined;
  let client: Sql | undefined;
  let db: PostgresJsDatabase;
  // createAcpReviewJob wants the app's db-singleton Queryable type; the container
  // client is structurally identical for .execute, so cast to the param type
  // rather than pulling in the singleton (which would talk to the real DB).
  let q: Parameters<typeof createAcpReviewJob>[0];

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    client = postgres(container.getConnectionUri(), { max: 4 });
    db = drizzle(client);
    q = db as unknown as Parameters<typeof createAcpReviewJob>[0];
    await applyAllMigrations(client);
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it("re-reviews a target after the prior job terminally failed, and releases the stale key", async () => {
    const targetKey = "acp-target:release:pr7";
    const first = await createAcpReviewJob(
      q,
      acpArgs({ acpJobId: "job-A", targetKey, prNumber: 7 }),
    );
    expect(first.created).toBe(true);

    // Terminalize job A to 'failed' — its non-null acp_target_key still occupies
    // the (non-status-scoped) unique index, which pre-fix blocked the next insert.
    await db.execute(
      sql`UPDATE review_jobs SET status = 'failed', completed_at = now() WHERE job_id = ${first.row.jobId}`,
    );

    const second = await createAcpReviewJob(
      q,
      acpArgs({ acpJobId: "job-B", targetKey, prNumber: 7 }),
    );
    expect(second.created).toBe(true);
    expect(second.row.jobId).not.toBe(first.row.jobId);
    expect(second.row.acpTargetKey).toBe(targetKey);

    // The failed holder's key was released (nulled) so the new job could take it.
    const released = await db.execute(
      sql`SELECT acp_target_key FROM review_jobs WHERE job_id = ${first.row.jobId}`,
    );
    expect((released[0] as { acp_target_key: string | null }).acp_target_key).toBeNull();
  });

  it("dedupes an ACTIVE target — returns the in-flight job, creates no new row", async () => {
    const targetKey = "acp-target:active:pr8";
    const first = await createAcpReviewJob(
      q,
      acpArgs({ acpJobId: "job-C", targetKey, prNumber: 8 }),
    );
    expect(first.created).toBe(true);

    const second = await createAcpReviewJob(
      q,
      acpArgs({ acpJobId: "job-D", targetKey, prNumber: 8 }),
    );
    expect(second.created).toBe(false);
    expect(second.row.jobId).toBe(first.row.jobId);
  });

  it("dedupes a COMPLETED target — a finished review is not re-run", async () => {
    const targetKey = "acp-target:completed:pr9";
    const first = await createAcpReviewJob(
      q,
      acpArgs({ acpJobId: "job-E", targetKey, prNumber: 9 }),
    );
    expect(first.created).toBe(true);
    await db.execute(
      sql`UPDATE review_jobs SET status = 'complete', completed_at = now() WHERE job_id = ${first.row.jobId}`,
    );

    const second = await createAcpReviewJob(
      q,
      acpArgs({ acpJobId: "job-F", targetKey, prNumber: 9 }),
    );
    expect(second.created).toBe(false);
    expect(second.row.jobId).toBe(first.row.jobId);
  });
});
