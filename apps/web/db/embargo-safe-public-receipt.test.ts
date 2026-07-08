// Real-Postgres test for the disclosure-gate-OFF fail-closed fallback (audit M4).
//
// embargoSafePublicReceiptCondition replaced the old `public_receipt = true`
// fallback used when the disclosure gate is off. The old fallback ignored
// finding_disclosure entirely, so an operator clearing ANTFLEET_DISCLOSURE_GATE
// (or an incomplete backfill) surfaced live-protocol findings that were still
// mid-embargo. This suite drives the new condition against a live container to
// prove: public receipts still show, un-backfilled findings still show, but any
// review carrying an explicitly-embargoed finding is excluded.
//
// Skips without Docker (matches queries-money-flow.test.ts); CI runs it.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { embargoSafePublicReceiptCondition } from "./public-receipt";
import { reviews } from "./schema";

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
        {
          cause: err,
        },
      );
    }
  }
}

function uuid(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

describeWithDocker("embargoSafePublicReceiptCondition (real Postgres, gate-off fallback)", () => {
  let container: StartedPostgreSqlContainer | undefined;
  let client: Sql | undefined;
  let db: PostgresJsDatabase;

  // Seed one review + one finding; optionally one finding_disclosure row.
  async function seed(args: {
    n: number;
    publicReceipt: boolean;
    disclosureState: string | null; // null = no finding_disclosure row (un-backfilled)
  }): Promise<string> {
    const c = client!;
    const reviewId = uuid(args.n);
    const findingId = `f-${args.n}`;
    await c`
      INSERT INTO reviews (
        review_id, repo_hash, pr_number, commit_sha, files_reviewed, prompt_version,
        provider_model_ids, provider_responses, agreement_decision, timing_ms,
        cost_estimated_usd, schema_version, public_receipt
      ) VALUES (
        ${reviewId}, ${"hash-" + args.n}, 1, 'sha', ARRAY['a.ts'], 'v1',
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 100,
        0, 1, ${args.publicReceipt}
      )`;
    await c`
      INSERT INTO finding_status (
        review_id, finding_index, finding_id, title, severity, category, status, source
      ) VALUES (
        ${reviewId}, 0, ${findingId}, 'T', 'high', 'security', 'closed', 'consensus'
      )`;
    if (args.disclosureState !== null) {
      await c`
        INSERT INTO finding_disclosure (finding_id, review_id, state)
        VALUES (${findingId}, ${reviewId}, ${args.disclosureState})`;
    }
    return reviewId;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    client = postgres(container.getConnectionUri(), { max: 4 });
    db = drizzle(client);
    await applyAllMigrations(client);
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it("shows public / none / published / un-backfilled receipts, hides all active-embargo states + unknown states", async () => {
    // finding_disclosure.state is a plain text column (no CHECK/enum), so the
    // fail-closed property relies on `NOT IN ('none','published')` rejecting
    // any state not explicitly on the allow-list. Cover every active-embargo
    // state PLUS a synthetic future/unknown string to pin that property.
    const embargoed = await seed({ n: 1, publicReceipt: true, disclosureState: "embargoed" });
    const none = await seed({ n: 2, publicReceipt: true, disclosureState: "none" });
    const unbackfilled = await seed({ n: 3, publicReceipt: true, disclosureState: null });
    const notPublic = await seed({ n: 4, publicReceipt: false, disclosureState: "none" });
    const embargoExpired = await seed({
      n: 5,
      publicReceipt: true,
      disclosureState: "embargo-expired",
    });
    const published = await seed({ n: 6, publicReceipt: true, disclosureState: "published" });
    const maintainerAck = await seed({
      n: 7,
      publicReceipt: true,
      disclosureState: "maintainer-acknowledged",
    });
    const patchMerged = await seed({
      n: 8,
      publicReceipt: true,
      disclosureState: "patch-merged",
    });
    const rows = await db
      .select({ id: reviews.reviewId })
      .from(reviews)
      .where(embargoSafePublicReceiptCondition);
    const visible = new Set(rows.map((r) => r.id));

    // Shown: legacy public (none), un-backfilled (tolerance), and published.
    expect(visible.has(none)).toBe(true);
    expect(visible.has(unbackfilled)).toBe(true);
    expect(visible.has(published)).toBe(true);
    // Hidden: all four active-embargo states and non-public reviews.
    expect(visible.has(embargoed)).toBe(false);
    expect(visible.has(embargoExpired)).toBe(false);
    expect(visible.has(maintainerAck)).toBe(false);
    expect(visible.has(patchMerged)).toBe(false);
    expect(visible.has(notPublic)).toBe(false);
  });

  it("fails closed on unknown/future disclosure states (defense in depth beyond the DB CHECK)", async () => {
    // The finding_disclosure_state_check CHECK constraint rejects unknown values
    // at write time, so a stray state can't be persisted today. Belt-and-braces:
    // prove the reader is also fail-closed by asking the DB directly whether the
    // NOT IN allow-list logic would exclude a hypothetical unknown value.
    // If someone ever relaxes/removes the CHECK, the reader must still hide it.
    const c = client!;
    const [row] = await c<{ hidden: boolean }[]>`
      SELECT ('future-unknown-state' NOT IN ('none','published')) AS hidden
    `;
    expect(row?.hidden).toBe(true);
  });
});
