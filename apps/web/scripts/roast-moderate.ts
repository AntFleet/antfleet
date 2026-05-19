/**
 * Operator moderation for roast_submissions. New submissions start as
 * awaiting_approval; promote explicitly to queued before the runner can claim.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/roast-moderate.ts list
 *   pnpm exec tsx scripts/roast-moderate.ts promote <submission-id> [--apply]
 *   pnpm exec tsx scripts/roast-moderate.ts reject <submission-id> --reason "..." [--apply]
 */
import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";
import { ROAST_STATUSES, type RoastSubmissionStatus } from "../lib/roast-status";

const AWAITING_APPROVAL = "awaiting_approval" satisfies RoastSubmissionStatus;
const QUEUED = "queued" satisfies RoastSubmissionStatus;
const REJECTED = "rejected" satisfies RoastSubmissionStatus;

type Queryable = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

type AwaitingRow = {
  id: string;
  source: string;
  repo_full_name: string;
  submitter_handle: string | null;
  created_at: Date | string;
};

type MutationRow = {
  id: string;
  repo_full_name: string;
};

type ModerateResult =
  | { action: "list"; rows: AwaitingRow[] }
  | { action: "promote"; applied: boolean; rows: MutationRow[] }
  | { action: "reject"; applied: boolean; rows: MutationRow[] };

export async function moderateRoastSubmissions(
  argv: string[],
  db: Queryable,
  log: Pick<Console, "log"> = console,
): Promise<ModerateResult> {
  const { command, submissionId, reason, apply } = parseArgs(argv);

  if (command === "list") {
    const result = await db.query<AwaitingRow>(
      `SELECT id, source, repo_full_name, submitter_handle, created_at
       FROM roast_submissions
       WHERE status = $1
       ORDER BY created_at ASC`,
      [AWAITING_APPROVAL],
    );
    printList(result.rows, log);
    return { action: "list", rows: result.rows };
  }

  if (command === "promote") {
    if (!apply) {
      const candidate = await selectAwaiting(db, submissionId);
      if (candidate.rows.length === 0) {
        log.log(`skipped: ${submissionId} is not awaiting approval or does not exist.`);
      } else {
        const row = candidate.rows[0]!;
        log.log(`dry-run: would promote ${row.id} ${row.repo_full_name} to ${QUEUED}.`);
      }
      return { action: "promote", applied: false, rows: candidate.rows };
    }

    const result = await db.query<MutationRow>(
      `UPDATE roast_submissions
       SET status = $2
       WHERE id = $1 AND status = $3
       RETURNING id, repo_full_name`,
      [submissionId, QUEUED, AWAITING_APPROVAL],
    );
    printMutation("promoted", submissionId, result.rows, log);
    return { action: "promote", applied: true, rows: result.rows };
  }

  if (reason === undefined || reason.length === 0) {
    throw new Error('reject requires --reason "..."');
  }

  if (!apply) {
    const candidate = await selectAwaiting(db, submissionId);
    if (candidate.rows.length === 0) {
      log.log(`skipped: ${submissionId} is not awaiting approval or does not exist.`);
    } else {
      const row = candidate.rows[0]!;
      log.log(`dry-run: would reject ${row.id} ${row.repo_full_name}: ${reason}`);
    }
    return { action: "reject", applied: false, rows: candidate.rows };
  }

  const result = await db.query<MutationRow>(
    `UPDATE roast_submissions
     SET status = $2, rejection_reason = $3
     WHERE id = $1 AND status = $4
     RETURNING id, repo_full_name`,
    [submissionId, REJECTED, reason, AWAITING_APPROVAL],
  );
  printMutation("rejected", submissionId, result.rows, log);
  return { action: "reject", applied: true, rows: result.rows };
}

function parseArgs(argv: string[]) {
  const command = argv[0];
  if (command !== "list" && command !== "promote" && command !== "reject") {
    throw new Error(
      'usage: roast-moderate.ts list | promote <submission-id> [--apply] | reject <submission-id> --reason "..." [--apply]',
    );
  }
  if (command === "list") return { command, submissionId: "", apply: argv.includes("--apply") };

  const submissionId = argv[1];
  if (submissionId === undefined || submissionId.startsWith("--")) {
    throw new Error(`usage: roast-moderate.ts ${command} <submission-id>`);
  }

  const reasonFlag = argv.indexOf("--reason");
  const reason = reasonFlag === -1 ? undefined : argv[reasonFlag + 1];
  return { command, submissionId, reason, apply: argv.includes("--apply") };
}

async function selectAwaiting(db: Queryable, submissionId: string) {
  return db.query<MutationRow>(
    `SELECT id, repo_full_name
     FROM roast_submissions
     WHERE id = $1 AND status = $2`,
    [submissionId, AWAITING_APPROVAL],
  );
}

function printList(rows: AwaitingRow[], log: Pick<Console, "log">): void {
  log.log(`valid statuses: ${ROAST_STATUSES.join(", ")}`);
  if (rows.length === 0) {
    log.log("(no submissions awaiting approval)");
    return;
  }
  log.log("id\tsource\trepo_full_name\tsubmitter_handle\tcreated_at");
  for (const row of rows) {
    log.log(
      `${row.id}\t${row.source}\t${row.repo_full_name}\t${row.submitter_handle ?? "-"}\t${toIso(row.created_at)}`,
    );
  }
}

function printMutation(
  verb: "promoted" | "rejected",
  submissionId: string,
  rows: MutationRow[],
  log: Pick<Console, "log">,
): void {
  if (rows.length === 0) {
    log.log(`skipped: ${submissionId} is not awaiting approval or does not exist.`);
    return;
  }
  const row = rows[0]!;
  log.log(`${verb}: ${row.id} ${row.repo_full_name}`);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is not set; populate apps/web/.env.local");
  }
  return databaseUrl;
}

function isDirectCliInvocation(): boolean {
  const scriptPath = process.argv[1];
  return scriptPath !== undefined && import.meta.url === pathToFileURL(scriptPath).href;
}

if (isDirectCliInvocation()) {
  runRoastModerateCli().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  });
}

export async function runRoastModerateCli(argv = process.argv.slice(2)): Promise<void> {
  loadDotenv({ path: ".env.local", quiet: true });
  const { Pool } = await import("@neondatabase/serverless");
  const databaseUrl = requireDatabaseUrl();
  const host = databaseUrl.match(/@([^/]+)/)?.[1] ?? "(unknown)";
  // eslint-disable-next-line no-console
  console.log(`target host: ${host}`);

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await moderateRoastSubmissions(argv, pool);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
