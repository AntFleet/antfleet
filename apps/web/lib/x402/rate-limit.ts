import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { ReviewJobRow } from "@/lib/review-job-queries";

type Queryable = Pick<typeof db, "execute">;

export const X402_WALLET_LIMIT = 10;
export const X402_WALLET_WINDOW_SECONDS = 60 * 60;
export const X402_REPO_COOLDOWN_SECONDS = 10 * 60;

export type WalletRateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number; limit: number };

export async function checkWalletRateLimit(
  q: Queryable,
  args: { callerWallet: string; now: Date; limit?: number; windowSeconds?: number },
): Promise<WalletRateLimitResult> {
  const limit = args.limit ?? X402_WALLET_LIMIT;
  const windowSeconds = args.windowSeconds ?? X402_WALLET_WINDOW_SECONDS;
  const windowStart = new Date(args.now.getTime() - windowSeconds * 1000);
  const result = await q.execute(sql`
    SELECT created_at AS "createdAt"
    FROM review_jobs
    WHERE payment_rail = 'x402'
      AND lower(caller_wallet) = ${args.callerWallet.toLowerCase()}
      AND created_at >= ${windowStart}
      AND (
        status IN ('queued', 'running', 'complete')
        OR (status = 'failed' AND failure_mode IN ('user_input', 'validation'))
      )
    ORDER BY created_at ASC
  `);
  const rows = rowsOf<{ createdAt: Date | string }>(result);
  if (rows.length < limit) return { ok: true };
  const oldest = parseDate(rows[0]!.createdAt);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((oldest.getTime() + windowSeconds * 1000 - args.now.getTime()) / 1000),
  );
  return { ok: false, retryAfterSeconds, limit };
}

export async function findRecentRepoShaJob(
  q: Queryable,
  args: { owner: string; repo: string; sha: string; now: Date; cooldownSeconds?: number },
): Promise<ReviewJobRow | null> {
  const cooldownSeconds = args.cooldownSeconds ?? X402_REPO_COOLDOWN_SECONDS;
  const windowStart = new Date(args.now.getTime() - cooldownSeconds * 1000);
  const result = await q.execute(sql`
    SELECT ${JOB_SELECT}
    FROM review_jobs
    WHERE payment_rail = 'x402'
      AND lower(repo_owner) = ${args.owner.toLowerCase()}
      AND lower(repo_name) = ${args.repo.toLowerCase()}
      AND lower(sha) = ${args.sha.toLowerCase()}
      AND created_at >= ${windowStart}
      AND status IN ('queued', 'running', 'complete')
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const row = firstRow<ReviewJobRow>(result);
  return row === null ? null : normalizeReviewJobRow(row);
}

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
  caller_wallet AS "callerWallet",
  payment_rail AS "paymentRail",
  x402_pay_to AS "x402PayTo",
  created_at AS "createdAt",
  started_at AS "startedAt",
  completed_at AS "completedAt",
  expires_at AS "expiresAt"
`;

function normalizeReviewJobRow(row: ReviewJobRow): ReviewJobRow {
  return {
    ...row,
    createdAt: parseDate(row.createdAt),
    startedAt: row.startedAt ? parseDate(row.startedAt) : null,
    completedAt: row.completedAt ? parseDate(row.completedAt) : null,
    expiresAt: parseDate(row.expiresAt),
  };
}

function parseDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
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
