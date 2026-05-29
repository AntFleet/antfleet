import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { describe, expect, it } from "vitest";
import {
  applyMigration0028,
  migration0028Statements,
  verifyMigration0028,
} from "./apply-migration-0028";

const sqlText = readFileSync(join(__dirname, "0028_review_jobs_x402.sql"), "utf8");
const migration0024Text = readFileSync(join(__dirname, "0024_review_jobs.sql"), "utf8");
const migration0027Text = readFileSync(
  join(__dirname, "0027_review_jobs_billing_pending.sql"),
  "utf8",
);

type SqlRow = Record<string, unknown>;
type MigrationSql = {
  (statement: string): Promise<SqlRow[]>;
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
};

function hasDocker(): boolean {
  const result = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return result.status === 0;
}

function sqlLiteral(value: unknown): string {
  if (value === null) return "NULL";
  if (value instanceof Date) return `'${value.toISOString().replaceAll("'", "''")}'`;
  return `'${String(value).replaceAll("'", "''")}'`;
}

function formatSql(strings: TemplateStringsArray | string, values: unknown[]): string {
  if (typeof strings === "string") return strings;
  return strings.reduce((text, part, index) => {
    const value = index < values.length ? sqlLiteral(values[index]) : "";
    return `${text}${part}${value}`;
  }, "");
}

async function psql(container: StartedPostgreSqlContainer, statement: string): Promise<string> {
  const result = await container.exec([
    "psql",
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    container.getUsername(),
    "-d",
    container.getDatabase(),
    "-At",
    "-F",
    "\t",
    "-c",
    statement,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`psql failed (${result.exitCode}): ${result.stderr || result.output}`);
  }
  return result.stdout.trim();
}

function rowsFrom(output: string): string[][] {
  if (!output) return [];
  return output.split("\n").map((line) => line.split("\t"));
}

async function queryRows(
  container: StartedPostgreSqlContainer,
  statement: string,
): Promise<string[][]> {
  return rowsFrom(await psql(container, statement));
}

function makeMigrationSql(container: StartedPostgreSqlContainer): MigrationSql {
  const fn = async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
    const statement = formatSql(strings, values);
    const rows = await queryRows(container, statement);

    if (statement.includes("column_name")) {
      return rows.map(([column_name]) => ({ column_name }));
    }
    if (statement.includes("constraint_name")) {
      return rows.map(([constraint_name]) => ({ constraint_name }));
    }
    if (statement.includes("indexname")) {
      return rows.map(([indexname]) => ({ indexname }));
    }
    return [];
  };
  return fn as MigrationSql;
}

async function applyStatements(container: StartedPostgreSqlContainer, text: string): Promise<void> {
  for (const statement of migration0028Statements(text)) {
    await psql(container, statement);
  }
}

async function prepareHead0027(container: StartedPostgreSqlContainer): Promise<void> {
  await psql(container, "CREATE TABLE payments (id uuid PRIMARY KEY)");
  await applyStatements(container, migration0024Text);
  await applyStatements(container, migration0027Text);
  await psql(
    container,
    `
      INSERT INTO review_jobs (
        job_id,
        installation_id,
        wallet_address,
        repo_owner,
        repo_name,
        pr_number,
        sha,
        idempotency_key,
        status,
        failure_mode,
        expires_at
      ) VALUES
        ('complete-job', 'inst-1', '0xwallet1', 'antfleet', 'fixture', 1, 'abc123', 'key-1', 'complete', 'provider_error', now() + interval '1 day'),
        ('queued-job', 'inst-2', '0xwallet2', 'antfleet', 'fixture', 2, 'def456', 'key-2', 'queued', 'timeout', now() + interval '1 day')
    `,
  );
}

describe("migration 0028 static shape", () => {
  it("keeps the idempotent statement contract aligned with x402 review_jobs columns", () => {
    const statements = migration0028Statements(sqlText);
    expect(statements.join("\n")).not.toContain("review_jobs_failure_mode_check");
    expect(statements.join("\n")).toContain("payment_rail = 'channel'");
    expect(statements.join("\n")).toContain(
      "DROP CONSTRAINT IF EXISTS review_jobs_payment_rail_check",
    );
    expect(statements.join("\n")).toContain(
      "DROP CONSTRAINT IF EXISTS review_jobs_x402_settlement_status_check",
    );
    expect(statements.filter((s) => /^ALTER TABLE review_jobs/i.test(s)).length).toBeGreaterThan(
      0,
    );
  });
});

const describeWithDocker = hasDocker() ? describe : describe.skip;

describeWithDocker("migration 0028 real Postgres apply", () => {
  it("applies against schema head 0027, verifies catalog state, and is idempotent", async () => {
    let container: StartedPostgreSqlContainer | undefined;
    try {
      container = await new PostgreSqlContainer("postgres:16-alpine")
        .withDatabase("antfleet_test")
        .withUsername("antfleet")
        .withPassword("antfleet")
        .start();

      await prepareHead0027(container);
      const sql = makeMigrationSql(container);
      await applyMigration0028(sql, sqlText);
      await applyMigration0028(sql, sqlText);

      const verification = await verifyMigration0028(sql);
      expect(verification.columns).toEqual([
        "caller_wallet",
        "payment_rail",
        "x402_pay_to",
        "x402_payment_payload",
        "x402_review_id",
        "x402_settlement_response",
        "x402_settlement_status",
        "x402_valid_after",
        "x402_valid_before",
      ]);
      expect(verification.indexes).toEqual([
        "idx_review_jobs_caller_wallet",
        "idx_review_jobs_payment_rail_created",
        "idx_review_jobs_rail_installation_idempotency_unique",
        "idx_review_jobs_x402_pay_to",
        "idx_review_jobs_x402_review_id",
        "idx_review_jobs_x402_settlement_status",
      ]);
      expect(verification.hasSettlementConstraint).toBe(true);
      expect(verification.hasFailureModeConstraint).toBe(false);

      const columnRows = await queryRows(
        container,
        `
          SELECT column_name, data_type, is_nullable, COALESCE(column_default, '')
          FROM information_schema.columns
          WHERE table_name = 'review_jobs'
            AND column_name IN (
              'caller_wallet',
              'payment_rail',
              'x402_pay_to',
              'x402_payment_payload',
              'x402_valid_after',
              'x402_valid_before',
              'x402_review_id',
              'x402_settlement_status',
              'x402_settlement_response'
            )
          ORDER BY column_name
        `,
      );
      expect(Object.fromEntries(columnRows.map(([name, type, nullable, defaultValue]) => [
        name,
        { type, nullable, defaultValue },
      ]))).toMatchObject({
        caller_wallet: { type: "text", nullable: "YES", defaultValue: "" },
        payment_rail: { type: "text", nullable: "NO", defaultValue: "'channel'::text" },
        x402_payment_payload: { type: "jsonb", nullable: "YES", defaultValue: "" },
        x402_settlement_response: { type: "jsonb", nullable: "YES", defaultValue: "" },
        x402_valid_after: { type: "timestamp with time zone", nullable: "YES", defaultValue: "" },
        x402_valid_before: { type: "timestamp with time zone", nullable: "YES", defaultValue: "" },
      });

      const constraintRows = await queryRows(
        container,
        `
          SELECT c.conname, pg_get_constraintdef(c.oid)
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          WHERE t.relname = 'review_jobs'
          ORDER BY c.conname
        `,
      );
      const constraints = Object.fromEntries(constraintRows.map(([name, definition]) => [
        name,
        definition,
      ]));
      expect(constraints["review_jobs_payment_rail_check"]).toContain("'x402'::text");
      expect(constraints["review_jobs_x402_settlement_status_check"]).toContain(
        "'settlement_failed'::text",
      );
      expect(constraints["review_jobs_failure_mode_check"]).toBeUndefined();

      const seededRows = await queryRows(
        container,
        `
          SELECT job_id, payment_rail, failure_mode, status
          FROM review_jobs
          ORDER BY job_id
        `,
      );
      expect(seededRows).toEqual([
        ["complete-job", "channel", "provider_error", "complete"],
        ["queued-job", "channel", "timeout", "queued"],
      ]);
    } finally {
      await container?.stop();
    }
  }, 120_000);
});
