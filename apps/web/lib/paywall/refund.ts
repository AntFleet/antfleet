// Channel refund for automated review job failures. Only triggers on
// provider_error, timeout, or internal failures — never on user_input
// or validation errors (the caller caused those; debit stands).
//
// Race-safe: the CTE gates all branches on a FOR UPDATE SKIP LOCKED
// claim of the job row with refund_payment_id IS NULL. Two concurrent
// callers serialize at the row lock; the loser's SKIP LOCKED returns
// zero rows and the downstream INSERT/UPDATE CTEs produce nothing.

import { sql } from "drizzle-orm";
import { db } from "@/db";
import { logError, logInfo } from "@/lib/log";

type Queryable = Pick<typeof db, "execute">;

// Allow-list of failure modes that trigger a refund. Explicit so new
// failure modes default to non-refundable (safe for the operator).
const REFUNDABLE_FAILURE_MODES = new Set([
  "provider_error",
  "timeout",
  "internal",
  "cost_cap_exceeded",
]);

export function isRefundableFailureMode(failureMode: string): boolean {
  return REFUNDABLE_FAILURE_MODES.has(failureMode);
}

// Static messages for API callers. Raw error details stay in server logs.
const SAFE_FAILURE_MESSAGES: Record<string, string> = {
  provider_error: "The review provider returned an error. Your channel has been refunded.",
  timeout: "The review timed out. Your channel has been refunded.",
  internal: "An internal error occurred. Your channel has been refunded.",
  cost_cap_exceeded: "The review exceeded the inference cost cap. Your channel has been refunded.",
  user_input: "The review could not proceed due to invalid input.",
  validation: "Validation failed for the requested review.",
};

export function safeFailureMessage(failureMode: string): string {
  return SAFE_FAILURE_MESSAGES[failureMode] ?? "An unexpected error occurred.";
}

export async function refundJobChannelDebit(
  q: Queryable,
  jobId: string,
): Promise<{ refunded: boolean; refundPaymentId: string | null }> {
  // 1. Load the job + its debit payment
  const jobResult = await q.execute(sql`
    SELECT
      rj.job_id AS "jobId",
      rj.debit_payment_id AS "debitPaymentId",
      rj.refund_payment_id AS "refundPaymentId",
      rj.failure_mode AS "failureMode",
      rj.wallet_address AS "walletAddress",
      p.channel_id AS "channelId",
      p.amount_usdc AS "amountUsdc"
    FROM review_jobs rj
    LEFT JOIN payments p ON p.id = rj.debit_payment_id
    WHERE rj.job_id = ${jobId}
    LIMIT 1
  `);
  const job = firstRow<{
    jobId: string;
    debitPaymentId: string | null;
    refundPaymentId: string | null;
    failureMode: string | null;
    walletAddress: string;
    channelId: string | null;
    amountUsdc: string | null;
  }>(jobResult);

  if (job === null) {
    logError("refund.job_not_found", { jobId });
    return { refunded: false, refundPaymentId: null };
  }

  // Guard: already refunded
  if (job.refundPaymentId !== null) {
    logInfo("refund.already_refunded", { jobId, refundPaymentId: job.refundPaymentId });
    return { refunded: false, refundPaymentId: job.refundPaymentId };
  }

  // Guard: no debit to refund (legacy/bypass path)
  if (job.debitPaymentId === null || job.channelId === null || job.amountUsdc === null) {
    logInfo("refund.no_debit_to_refund", { jobId });
    return { refunded: false, refundPaymentId: null };
  }

  // Guard: failure mode must be refundable
  if (job.failureMode === null || !isRefundableFailureMode(job.failureMode)) {
    logInfo("refund.non_refundable_failure", { jobId, failureMode: job.failureMode });
    return { refunded: false, refundPaymentId: null };
  }

  // 2. Race-safe refund via FOR UPDATE SKIP LOCKED.
  //
  // The `claimable` CTE locks the job row atomically; SKIP LOCKED means
  // a concurrent caller sees zero rows and the downstream INSERT/UPDATE
  // CTEs execute against an empty set — no payment inserted, no channel
  // credited, no link written. This eliminates the double-credit race
  // that the security reviewer flagged.
  const refundResult = await q.execute(sql`
    WITH claimable AS (
      SELECT job_id, wallet_address
      FROM review_jobs
      WHERE job_id = ${jobId} AND refund_payment_id IS NULL
      FOR UPDATE SKIP LOCKED
    ),
    refund_insert AS (
      INSERT INTO payments (channel_id, type, chain_id, from_address, amount_usdc)
      SELECT
        ${job.channelId},
        'refund',
        8453,
        ${job.walletAddress.toLowerCase()},
        ${job.amountUsdc}
      FROM claimable
      WHERE EXISTS (SELECT 1 FROM claimable)
      RETURNING id
    ),
    credit_channel AS (
      UPDATE channels
      SET balance_usdc = balance_usdc + ${job.amountUsdc}::numeric
      WHERE id = ${job.channelId}
        AND EXISTS (SELECT 1 FROM claimable)
      RETURNING id
    ),
    link_job AS (
      UPDATE review_jobs
      SET refund_payment_id = (SELECT id FROM refund_insert)
      WHERE job_id = ${jobId} AND refund_payment_id IS NULL
        AND EXISTS (SELECT 1 FROM claimable)
      RETURNING job_id
    )
    SELECT (SELECT id FROM refund_insert) AS "refundPaymentId"
  `);

  const refundRow = firstRow<{ refundPaymentId: string | null }>(refundResult);
  if (refundRow === null || refundRow.refundPaymentId === null) {
    // Either no row returned (empty claimable) or refund_insert produced nothing.
    // This is the expected outcome for the loser of a concurrent race.
    logInfo("refund.skipped_or_race_lost", { jobId });
    return { refunded: false, refundPaymentId: null };
  }

  logInfo("refund.completed", {
    jobId,
    refundPaymentId: refundRow.refundPaymentId,
    amountUsdc: job.amountUsdc,
    channelId: job.channelId,
  });

  return { refunded: true, refundPaymentId: refundRow.refundPaymentId };
}

function firstRow<T>(result: unknown): T | null {
  const rows = Array.isArray(result)
    ? result
    : Array.isArray((result as { rows?: unknown[] }).rows)
      ? (result as { rows: unknown[] }).rows
      : [];
  return (rows[0] as T | undefined) ?? null;
}
