// Review job queue CRUD. Used by the async POST endpoint, GET polling
// endpoint, worker, refund flow, and safety-net cron. All mutations use
// state-machine guards so concurrent callers can't corrupt the lifecycle.

import { nanoid } from "nanoid";
import { sql } from "drizzle-orm";
import { db } from "@/db";

type Queryable = Pick<typeof db, "execute">;

export type ReviewJobRow = {
  jobId: string;
  installationId: string;
  walletAddress: string;
  repoOwner: string;
  repoName: string;
  prNumber: number | null;
  sha: string | null;
  idempotencyKey: string | null;
  status: string;
  failureMode: string | null;
  failureMessage: string | null;
  result: unknown;
  debitPaymentId: string | null;
  refundPaymentId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date;
};

const JOB_SELECT = sql`
  job_id AS "jobId",
  installation_id AS "installationId",
  wallet_address AS "walletAddress",
  repo_owner AS "repoOwner",
  repo_name AS "repoName",
  pr_number AS "prNumber",
  sha,
  idempotency_key AS "idempotencyKey",
  status,
  failure_mode AS "failureMode",
  failure_message AS "failureMessage",
  result,
  debit_payment_id AS "debitPaymentId",
  refund_payment_id AS "refundPaymentId",
  created_at AS "createdAt",
  started_at AS "startedAt",
  completed_at AS "completedAt",
  expires_at AS "expiresAt"
`;

export async function createReviewJob(
  q: Queryable,
  args: {
    installationId: string;
    walletAddress: string;
    repoOwner: string;
    repoName: string;
    prNumber: number | null;
    sha: string | null;
    idempotencyKey: string | null;
    debitPaymentId: string | null;
  },
): Promise<ReviewJobRow> {
  const jobId = nanoid(21);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const result = await q.execute(sql`
    INSERT INTO review_jobs (
      job_id, installation_id, wallet_address, repo_owner, repo_name,
      pr_number, sha, idempotency_key, status, debit_payment_id, expires_at
    ) VALUES (
      ${jobId}, ${args.installationId}, ${args.walletAddress.toLowerCase()},
      ${args.repoOwner}, ${args.repoName}, ${args.prNumber}, ${args.sha},
      ${args.idempotencyKey}, 'queued', ${args.debitPaymentId}, ${expiresAt}
    )
    RETURNING ${JOB_SELECT}
  `);
  const row = firstRow<ReviewJobRow>(result);
  if (row === null) throw new Error("createReviewJob: insert returned no row");
  return normalizeRow(row);
}

export async function getReviewJob(
  q: Queryable,
  jobId: string,
): Promise<ReviewJobRow | null> {
  const result = await q.execute(sql`
    SELECT ${JOB_SELECT}
    FROM review_jobs
    WHERE job_id = ${jobId}
    LIMIT 1
  `);
  const row = firstRow<ReviewJobRow>(result);
  return row === null ? null : normalizeRow(row);
}

export async function findJobByIdempotencyKey(
  q: Queryable,
  installationId: string,
  idempotencyKey: string,
): Promise<ReviewJobRow | null> {
  const result = await q.execute(sql`
    SELECT ${JOB_SELECT}
    FROM review_jobs
    WHERE installation_id = ${installationId}
      AND idempotency_key = ${idempotencyKey}
    LIMIT 1
  `);
  const row = firstRow<ReviewJobRow>(result);
  return row === null ? null : normalizeRow(row);
}

// State-machine transition: queued → running. Returns false if the row
// is not in 'queued' (lost claim race or already running).
export async function markJobRunning(
  q: Queryable,
  jobId: string,
  now: Date,
): Promise<boolean> {
  const result = await q.execute(sql`
    UPDATE review_jobs
    SET status = 'running', started_at = ${now}
    WHERE job_id = ${jobId} AND status = 'queued'
    RETURNING job_id
  `);
  return firstRow<{ job_id: string }>(result) !== null;
}

// State-machine transition: running → complete.
export async function markJobComplete(
  q: Queryable,
  jobId: string,
  jobResult: unknown,
  now: Date,
): Promise<void> {
  await q.execute(sql`
    UPDATE review_jobs
    SET status = 'complete', result = ${JSON.stringify(jobResult)}::jsonb, completed_at = ${now}
    WHERE job_id = ${jobId} AND status = 'running'
  `);
}

// State-machine transition: running → failed.
export async function markJobFailed(
  q: Queryable,
  jobId: string,
  failureMode: string,
  failureMessage: string,
  now: Date,
): Promise<void> {
  await q.execute(sql`
    UPDATE review_jobs
    SET status = 'failed', failure_mode = ${failureMode},
        failure_message = ${failureMessage}, completed_at = ${now}
    WHERE job_id = ${jobId} AND status = 'running'
  `);
}

// Safety-net cron: find queued jobs older than threshold (orphan from
// waitUntil not firing). Returns job_ids for re-trigger.
export async function findStaleQueuedJobs(
  q: Queryable,
  olderThan: Date,
): Promise<ReviewJobRow[]> {
  const result = await q.execute(sql`
    SELECT ${JOB_SELECT}
    FROM review_jobs
    WHERE status = 'queued' AND created_at < ${olderThan}
    ORDER BY created_at ASC
    LIMIT 20
  `);
  return rowsOf<ReviewJobRow>(result).map(normalizeRow);
}

// Safety-net cron: find running jobs stuck longer than timeout.
export async function findStuckRunningJobs(
  q: Queryable,
  startedBefore: Date,
): Promise<ReviewJobRow[]> {
  const result = await q.execute(sql`
    SELECT ${JOB_SELECT}
    FROM review_jobs
    WHERE status = 'running' AND started_at < ${startedBefore}
    ORDER BY started_at ASC
    LIMIT 20
  `);
  return rowsOf<ReviewJobRow>(result).map(normalizeRow);
}

// Link debit payment to job row (called after debit succeeds).
export async function linkDebitPaymentToJob(
  q: Queryable,
  jobId: string,
  debitPaymentId: string,
): Promise<void> {
  await q.execute(sql`
    UPDATE review_jobs
    SET debit_payment_id = ${debitPaymentId}
    WHERE job_id = ${jobId} AND debit_payment_id IS NULL
  `);
}

// Link refund payment to the job row (called by refund flow).
export async function linkRefundToJob(
  q: Queryable,
  jobId: string,
  refundPaymentId: string,
): Promise<void> {
  await q.execute(sql`
    UPDATE review_jobs
    SET refund_payment_id = ${refundPaymentId}
    WHERE job_id = ${jobId} AND refund_payment_id IS NULL
  `);
}

// Purge result JSON for expired jobs (storage cleanup).
export async function purgeExpiredJobResults(
  q: Queryable,
  now: Date,
): Promise<number> {
  const result = await q.execute(sql`
    UPDATE review_jobs
    SET result = NULL
    WHERE expires_at < ${now} AND result IS NOT NULL
    RETURNING job_id
  `);
  return rowsOf<{ job_id: string }>(result).length;
}

function normalizeRow(row: ReviewJobRow): ReviewJobRow {
  return {
    ...row,
    createdAt: parseDate(row.createdAt),
    startedAt: row.startedAt ? parseDate(row.startedAt) : null,
    completedAt: row.completedAt ? parseDate(row.completedAt) : null,
    expiresAt: parseDate(row.expiresAt),
  };
}

function parseDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  throw new Error(`expected Date or ISO string, got ${typeof value}`);
}

function firstRow<T>(result: unknown): T | null {
  const rows = rowsOf<T>(result);
  return rows[0] ?? null;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (typeof result === "object" && result !== null && "rows" in result) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
