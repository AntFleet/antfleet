// Review job queue CRUD. Used by the async POST endpoint, GET polling
// endpoint, worker, refund flow, and safety-net cron. All mutations use
// state-machine guards so concurrent callers can't corrupt the lifecycle.

import { nanoid } from "nanoid";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { AcpReviewRequest } from "@/lib/acp/review-contract";

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
  callerWallet?: string | null;
  paymentRail?: "channel" | "x402" | "acp";
  x402PayTo?: string | null;
  x402PaymentPayload?: unknown;
  x402ValidAfter?: Date | null;
  x402ValidBefore?: Date | null;
  x402ReviewId?: string | null;
  x402SettlementStatus?: X402SettlementStatus | null;
  x402SettlementResponse?: unknown;
  acpJobId?: string | null;
  acpClientWallet?: string | null;
  acpTargetKey?: string | null;
  acpRequestPayload?: unknown;
  acpReviewId?: string | null;
  acpBudgetStatus?: AcpBudgetStatus | null;
  acpBudgetResponse?: unknown;
  acpBudgetAttempts?: number;
  acpBudgetUpdatedAt?: Date | null;
  acpSubmitStatus?: AcpSubmitStatus | null;
  acpSubmitResponse?: unknown;
  acpSubmittedAt?: Date | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date;
};

export type X402SettlementStatus = "pending" | "settled" | "not_settled" | "settlement_failed";
export type AcpBudgetStatus = "pending" | "setting" | "set" | "set_failed" | "set_reconcile";
export type AcpSubmitStatus = "pending" | "submitting" | "submitted" | "submit_failed";

export type ReviewJobInitialStatus = "billing_pending" | "queued";
export type CreateReviewJobResult = { row: ReviewJobRow; created: boolean };

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
  x402_payment_payload AS "x402PaymentPayload",
  x402_valid_after AS "x402ValidAfter",
  x402_valid_before AS "x402ValidBefore",
  x402_review_id AS "x402ReviewId",
  x402_settlement_status AS "x402SettlementStatus",
  x402_settlement_response AS "x402SettlementResponse",
  acp_job_id AS "acpJobId",
  acp_client_wallet AS "acpClientWallet",
  acp_target_key AS "acpTargetKey",
  acp_request_payload AS "acpRequestPayload",
  acp_review_id AS "acpReviewId",
  acp_budget_status AS "acpBudgetStatus",
  acp_budget_response AS "acpBudgetResponse",
  acp_budget_attempts AS "acpBudgetAttempts",
  acp_budget_updated_at AS "acpBudgetUpdatedAt",
  acp_submit_status AS "acpSubmitStatus",
  acp_submit_response AS "acpSubmitResponse",
  acp_submitted_at AS "acpSubmittedAt",
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
    initialStatus?: ReviewJobInitialStatus;
  },
): Promise<CreateReviewJobResult> {
  const jobId = nanoid(21);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const status = args.initialStatus ?? "queued";
  const result = await q.execute(sql`
    INSERT INTO review_jobs (
      job_id, installation_id, wallet_address, repo_owner, repo_name,
      pr_number, sha, idempotency_key, status, debit_payment_id, expires_at,
      payment_rail
    ) VALUES (
      ${jobId}, ${args.installationId}, ${args.walletAddress.toLowerCase()},
      ${args.repoOwner}, ${args.repoName}, ${args.prNumber}, ${args.sha},
      ${args.idempotencyKey}, ${status}, ${args.debitPaymentId}, ${expiresAt},
      'channel'
    )
    ON CONFLICT (payment_rail, installation_id, idempotency_key) DO NOTHING
    RETURNING ${JOB_SELECT}
  `);
  const row = firstRow<ReviewJobRow>(result);
  if (row !== null) return { row: normalizeRow(row), created: true };
  if (args.idempotencyKey === null) {
    throw new Error("createReviewJob: insert returned no row without idempotency key");
  }
  const existing = await findJobByIdempotencyKey(q, args.installationId, args.idempotencyKey);
  if (existing !== null) return { row: existing, created: false };
  throw new Error("createReviewJob: idempotency conflict returned no existing row");
}

export async function createX402ReviewJob(
  q: Queryable,
  args: {
    callerWallet: string;
    repoOwner: string;
    repoName: string;
    prNumber: number;
    sha: string;
    idempotencyKey: string;
    x402PayTo: string;
    authorizationState: unknown;
  },
): Promise<ReviewJobRow> {
  const jobId = nanoid(21);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const window = readAuthorizationDates(args.authorizationState);
  const result = await q.execute(sql`
    INSERT INTO review_jobs (
      job_id, installation_id, wallet_address, repo_owner, repo_name,
      pr_number, sha, idempotency_key, status, expires_at,
      caller_wallet, payment_rail, x402_pay_to, x402_payment_payload,
      x402_valid_after, x402_valid_before, x402_settlement_status
    ) VALUES (
      ${jobId}, 'x402', ${args.callerWallet.toLowerCase()},
      ${args.repoOwner}, ${args.repoName}, ${args.prNumber}, ${args.sha},
      ${args.idempotencyKey}, 'queued', ${expiresAt},
      ${args.callerWallet.toLowerCase()}, 'x402', ${args.x402PayTo},
      ${JSON.stringify(args.authorizationState)}::jsonb,
      ${window.validAfter}, ${window.validBefore}, 'pending'
    )
    ON CONFLICT (payment_rail, installation_id, idempotency_key) DO NOTHING
    RETURNING ${JOB_SELECT}
  `);
  const row = firstRow<ReviewJobRow>(result);
  if (row === null) {
    const existing = await findX402JobByIdempotencyKey(q, args.idempotencyKey);
    if (existing !== null) return existing;
    throw new Error("createX402ReviewJob: insert returned no row");
  }
  return normalizeRow(row);
}

export async function createAcpReviewJob(
  q: Queryable,
  args: {
    acpJobId: string;
    clientAgentWallet: string;
    repoOwner: string;
    repoName: string;
    prNumber: number | null;
    sha: string | null;
    requestPayload: AcpReviewRequest;
    targetKey?: string | null;
    idempotencyKey?: string | null;
    initialStatus?: ReviewJobInitialStatus;
  },
): Promise<CreateReviewJobResult> {
  const existingAcpJob = await findAcpJobByAcpJobId(q, args.acpJobId);
  if (existingAcpJob !== null) return { row: existingAcpJob, created: false };
  if (args.targetKey !== null && args.targetKey !== undefined) {
    const existingTarget = await findAcpJobByTargetKey(q, args.targetKey);
    if (existingTarget !== null) return { row: existingTarget, created: false };
  }
  const jobId = nanoid(21);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const status = args.initialStatus ?? "billing_pending";
  const idempotencyKey = args.idempotencyKey ?? `acp:${args.acpJobId}`;
  const clientWallet = args.clientAgentWallet.toLowerCase();
  const result = await q.execute(sql`
    INSERT INTO review_jobs (
      job_id, installation_id, wallet_address, repo_owner, repo_name,
      pr_number, sha, idempotency_key, status, expires_at,
      caller_wallet, payment_rail, acp_job_id, acp_client_wallet,
      acp_target_key, acp_request_payload, acp_budget_status, acp_submit_status
    ) VALUES (
      ${jobId}, 'acp', ${clientWallet},
      ${args.repoOwner}, ${args.repoName}, ${args.prNumber}, ${args.sha},
      ${idempotencyKey}, ${status}, ${expiresAt},
      ${clientWallet}, 'acp', ${args.acpJobId}, ${clientWallet},
      ${args.targetKey ?? null}, ${JSON.stringify(args.requestPayload)}::jsonb, 'pending', 'pending'
    )
    ON CONFLICT DO NOTHING
    RETURNING ${JOB_SELECT}
  `);
  const row = firstRow<ReviewJobRow>(result);
  if (row !== null) return { row: normalizeRow(row), created: true };
  const existing = await findAcpJobByIdempotencyKey(q, idempotencyKey);
  if (existing !== null) return { row: existing, created: false };
  if (args.targetKey !== null && args.targetKey !== undefined) {
    const existingTarget = await findAcpJobByTargetKey(q, args.targetKey);
    if (existingTarget !== null) return { row: existingTarget, created: false };
  }
  throw new Error("createAcpReviewJob: idempotency conflict returned no existing row");
}

export async function markJobQueued(q: Queryable, jobId: string): Promise<boolean> {
  const result = await q.execute(sql`
    UPDATE review_jobs
    SET status = 'queued'
    WHERE job_id = ${jobId} AND status = 'billing_pending'
    RETURNING job_id
  `);
  return firstRow<{ job_id: string }>(result) !== null;
}

export async function markAcpJobFundedAndQueued(q: Queryable, jobId: string): Promise<boolean> {
  const result = await q.execute(sql`
    UPDATE review_jobs
    SET status = 'queued'
    WHERE job_id = ${jobId}
      AND payment_rail = 'acp'
      AND status = 'billing_pending'
      AND acp_budget_status = 'set'
    RETURNING job_id
  `);
  return firstRow<{ job_id: string }>(result) !== null;
}

export async function markBillingJobFailed(
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
    WHERE job_id = ${jobId} AND status = 'billing_pending'
  `);
}

export async function getReviewJob(q: Queryable, jobId: string): Promise<ReviewJobRow | null> {
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

export async function findX402JobByIdempotencyKey(
  q: Queryable,
  idempotencyKey: string,
): Promise<ReviewJobRow | null> {
  const result = await q.execute(sql`
    SELECT ${JOB_SELECT}
    FROM review_jobs
    WHERE payment_rail = 'x402'
      AND idempotency_key = ${idempotencyKey}
    LIMIT 1
  `);
  const row = firstRow<ReviewJobRow>(result);
  return row === null ? null : normalizeRow(row);
}

export async function findAcpJobByAcpJobId(
  q: Queryable,
  acpJobId: string,
): Promise<ReviewJobRow | null> {
  const result = await q.execute(sql`
    SELECT ${JOB_SELECT}
    FROM review_jobs
    WHERE payment_rail = 'acp'
      AND acp_job_id = ${acpJobId}
    LIMIT 1
  `);
  const row = firstRow<ReviewJobRow>(result);
  return row === null ? null : normalizeRow(row);
}

export async function findAcpJobByIdempotencyKey(
  q: Queryable,
  idempotencyKey: string,
): Promise<ReviewJobRow | null> {
  const result = await q.execute(sql`
    SELECT ${JOB_SELECT}
    FROM review_jobs
    WHERE payment_rail = 'acp'
      AND installation_id = 'acp'
      AND idempotency_key = ${idempotencyKey}
    LIMIT 1
  `);
  const row = firstRow<ReviewJobRow>(result);
  return row === null ? null : normalizeRow(row);
}

export async function findAcpJobByTargetKey(
  q: Queryable,
  targetKey: string,
): Promise<ReviewJobRow | null> {
  const result = await q.execute(sql`
    SELECT ${JOB_SELECT}
    FROM review_jobs
    WHERE payment_rail = 'acp'
      AND acp_target_key = ${targetKey}
    LIMIT 1
  `);
  const row = firstRow<ReviewJobRow>(result);
  return row === null ? null : normalizeRow(row);
}

// State-machine transition: queued → running. Returns false if the row
// is not in 'queued' (lost claim race or already running).
export async function markJobRunning(q: Queryable, jobId: string, now: Date): Promise<boolean> {
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
): Promise<boolean> {
  const result = await q.execute(sql`
    UPDATE review_jobs
    SET status = 'complete', result = ${JSON.stringify(jobResult)}::jsonb, completed_at = ${now}
    WHERE job_id = ${jobId} AND status = 'running'
    RETURNING job_id
  `);
  return firstRow<{ job_id: string }>(result) !== null;
}

export async function markX402JobCompleteSettled(
  q: Queryable,
  jobId: string,
  jobResult: unknown,
  settlementResponse: unknown,
  now: Date,
): Promise<void> {
  await q.execute(sql`
    UPDATE review_jobs
    SET status = 'complete',
        result = ${JSON.stringify(jobResult)}::jsonb,
        completed_at = ${now},
        x402_settlement_status = 'settled',
        x402_settlement_response = ${JSON.stringify(settlementResponse)}::jsonb
    WHERE job_id = ${jobId}
      AND status = 'running'
      AND payment_rail = 'x402'
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
        failure_message = ${failureMessage}, result = NULL, completed_at = ${now}
    WHERE job_id = ${jobId} AND status = 'running'
  `);
}

// State-machine transition: running -> failed, preserving a public result payload
// for rails where the receipt URL is still part of the failure contract.
export async function markJobFailedWithResult(
  q: Queryable,
  jobId: string,
  failureMode: string,
  failureMessage: string,
  jobResult: unknown,
  now: Date,
): Promise<void> {
  await q.execute(sql`
    UPDATE review_jobs
    SET status = 'failed', failure_mode = ${failureMode},
        failure_message = ${failureMessage}, result = ${JSON.stringify(jobResult)}::jsonb,
        completed_at = ${now}
    WHERE job_id = ${jobId} AND status = 'running'
  `);
}

export async function markX402JobFailedWithResultAndSettlement(
  q: Queryable,
  jobId: string,
  failureMode: string,
  failureMessage: string,
  jobResult: unknown,
  settlementStatus: X402SettlementStatus,
  settlementResponse: unknown,
  now: Date,
): Promise<void> {
  const settlementResponseJson =
    settlementResponse === null ? null : JSON.stringify(settlementResponse);
  await q.execute(sql`
    UPDATE review_jobs
    SET status = 'failed',
        failure_mode = ${failureMode},
        failure_message = ${failureMessage},
        result = ${JSON.stringify(jobResult)}::jsonb,
        completed_at = ${now},
        x402_settlement_status = CASE
          WHEN x402_settlement_status IN ('settled', 'settlement_failed') THEN x402_settlement_status
          ELSE ${settlementStatus}
        END,
        x402_settlement_response = CASE
          WHEN x402_settlement_status IN ('settled', 'settlement_failed') THEN x402_settlement_response
          ELSE ${settlementResponseJson}::jsonb
        END
    WHERE job_id = ${jobId}
      AND status = 'running'
      AND payment_rail = 'x402'
  `);
}

export async function markX402JobReviewLinked(
  q: Queryable,
  jobId: string,
  reviewId: string,
): Promise<void> {
  await q.execute(sql`
    UPDATE review_jobs
    SET x402_review_id = ${reviewId}
    WHERE job_id = ${jobId} AND payment_rail = 'x402'
  `);
}

export async function markAcpJobReviewLinked(
  q: Queryable,
  jobId: string,
  reviewId: string,
): Promise<void> {
  await q.execute(sql`
    UPDATE review_jobs
    SET acp_review_id = ${reviewId}
    WHERE job_id = ${jobId} AND payment_rail = 'acp'
  `);
}

export async function markAcpJobBudgetSet(
  q: Queryable,
  jobId: string,
  budgetResponse: unknown,
  now: Date,
): Promise<void> {
  await q.execute(sql`
    UPDATE review_jobs
    SET acp_budget_status = 'set',
        acp_budget_response = ${JSON.stringify(budgetResponse)}::jsonb,
        acp_budget_attempts = acp_budget_attempts + 1,
        acp_budget_updated_at = ${now}
    WHERE job_id = ${jobId} AND payment_rail = 'acp'
  `);
}

export async function claimAcpJobBudgetSetting(
  q: Queryable,
  jobId: string,
  now: Date,
): Promise<boolean> {
  const result = await q.execute(sql`
    UPDATE review_jobs
    SET acp_budget_status = 'setting',
        acp_budget_updated_at = ${now}
    WHERE job_id = ${jobId}
      AND payment_rail = 'acp'
      AND status = 'billing_pending'
      AND (
        acp_budget_status IS NULL
        OR acp_budget_status IN ('pending','set_failed')
      )
    RETURNING job_id
  `);
  return firstRow<{ job_id: string }>(result) !== null;
}

export async function markAcpJobBudgetFailed(
  q: Queryable,
  jobId: string,
  budgetResponse: unknown,
  now: Date,
): Promise<void> {
  await q.execute(sql`
    UPDATE review_jobs
    SET acp_budget_status = 'set_failed',
        acp_budget_response = ${JSON.stringify(budgetResponse)}::jsonb,
        acp_budget_attempts = acp_budget_attempts + 1,
        acp_budget_updated_at = ${now}
    WHERE job_id = ${jobId} AND payment_rail = 'acp'
  `);
}

export async function markAcpJobBudgetReconciliationRequired(
  q: Queryable,
  jobId: string,
  budgetResponse: unknown,
  now: Date,
): Promise<void> {
  await q.execute(sql`
    UPDATE review_jobs
    SET acp_budget_status = 'set_reconcile',
        acp_budget_response = ${JSON.stringify(budgetResponse)}::jsonb,
        acp_budget_attempts = acp_budget_attempts + 1,
        acp_budget_updated_at = ${now}
    WHERE job_id = ${jobId} AND payment_rail = 'acp'
  `);
}

export async function markAcpJobSubmitting(
  q: Queryable,
  jobId: string,
  deliverable: unknown,
  now: Date,
): Promise<boolean> {
  const result = await q.execute(sql`
    UPDATE review_jobs
    SET acp_submit_status = 'submitting',
        acp_submit_response = ${JSON.stringify({ state: "submitting", deliverable })}::jsonb,
        acp_submitted_at = ${now}
    WHERE job_id = ${jobId}
      AND payment_rail = 'acp'
      AND status = 'running'
      AND (acp_submit_status IS NULL OR acp_submit_status IN ('pending','submit_failed'))
    RETURNING job_id
  `);
  return firstRow<{ job_id: string }>(result) !== null;
}

export async function markAcpJobSubmitted(
  q: Queryable,
  jobId: string,
  submitResponse: unknown,
  now: Date,
): Promise<void> {
  const responseJson =
    typeof submitResponse === "object" && submitResponse !== null
      ? { ...(submitResponse as Record<string, unknown>) }
      : { response: submitResponse };
  await q.execute(sql`
    UPDATE review_jobs
    SET acp_submit_status = 'submitted',
        acp_submit_response = jsonb_strip_nulls(
          COALESCE(acp_submit_response, '{}'::jsonb)
          || ${JSON.stringify({ state: "submitted", response: responseJson })}::jsonb
        ),
        acp_submitted_at = ${now}
    WHERE job_id = ${jobId}
      AND payment_rail = 'acp'
      AND (acp_submit_status IS NULL OR acp_submit_status <> 'submitted')
  `);
}

export async function markAcpJobSubmitFailed(
  q: Queryable,
  jobId: string,
  submitResponse: unknown,
  now: Date,
): Promise<void> {
  await q.execute(sql`
    UPDATE review_jobs
    SET acp_submit_status = 'submit_failed',
        acp_submit_response = ${JSON.stringify(submitResponse)}::jsonb,
        acp_submitted_at = ${now}
    WHERE job_id = ${jobId}
      AND payment_rail = 'acp'
      AND (acp_submit_status IS NULL OR acp_submit_status <> 'submitted')
  `);
}

export async function markX402SettlementSettled(
  q: Queryable,
  jobId: string,
  settlementResponse: unknown,
): Promise<void> {
  await q.execute(sql`
    UPDATE review_jobs
    SET x402_settlement_status = 'settled',
        x402_settlement_response = ${JSON.stringify(settlementResponse)}::jsonb
    WHERE job_id = ${jobId} AND payment_rail = 'x402'
  `);
}

export async function markX402SettlementNotSettled(q: Queryable, jobId: string): Promise<void> {
  await q.execute(sql`
    UPDATE review_jobs
    SET x402_settlement_status = 'not_settled',
        x402_settlement_response = NULL
    WHERE job_id = ${jobId}
      AND payment_rail = 'x402'
      AND (x402_settlement_status IS NULL OR x402_settlement_status = 'pending')
  `);
}

export async function markX402SettlementFailed(
  q: Queryable,
  jobId: string,
  settlementResponse: unknown,
): Promise<void> {
  await q.execute(sql`
    UPDATE review_jobs
    SET x402_settlement_status = 'settlement_failed',
        x402_settlement_response = ${JSON.stringify(settlementResponse)}::jsonb
    WHERE job_id = ${jobId}
      AND payment_rail = 'x402'
      AND x402_settlement_status IS DISTINCT FROM 'settled'
  `);
}

export async function markX402JobExpired(
  q: Queryable,
  jobId: string,
  now: Date,
): Promise<ReviewJobRow | null> {
  const result = await q.execute(sql`
    UPDATE review_jobs
    SET status = 'expired',
        completed_at = ${now},
        x402_settlement_status = 'not_settled',
        x402_settlement_response = NULL
    WHERE job_id = ${jobId}
      AND payment_rail = 'x402'
      AND status IN ('queued', 'running')
      AND x402_valid_before IS NOT NULL
      AND x402_valid_before <= ${now}
    RETURNING ${JOB_SELECT}
  `);
  const row = firstRow<ReviewJobRow>(result);
  return row === null ? null : normalizeRow(row);
}

// Safety-net cron: find queued jobs older than threshold (orphan from
// waitUntil not firing). Returns job_ids for re-trigger.
export async function findStaleQueuedJobs(q: Queryable, olderThan: Date): Promise<ReviewJobRow[]> {
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
export async function purgeExpiredJobResults(q: Queryable, now: Date): Promise<number> {
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
    x402ValidAfter: row.x402ValidAfter ? parseDate(row.x402ValidAfter) : null,
    x402ValidBefore: row.x402ValidBefore ? parseDate(row.x402ValidBefore) : null,
    acpSubmittedAt: row.acpSubmittedAt ? parseDate(row.acpSubmittedAt) : null,
    createdAt: parseDate(row.createdAt),
    startedAt: row.startedAt ? parseDate(row.startedAt) : null,
    completedAt: row.completedAt ? parseDate(row.completedAt) : null,
    expiresAt: parseDate(row.expiresAt),
  };
}

function readAuthorizationDates(value: unknown): { validAfter: Date; validBefore: Date } {
  if (typeof value !== "object" || value === null) {
    throw new Error("createX402ReviewJob: authorizationState must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record["validAfter"] !== "string" || typeof record["validBefore"] !== "string") {
    throw new Error("createX402ReviewJob: authorizationState window missing");
  }
  return {
    validAfter: new Date(record["validAfter"]),
    validBefore: new Date(record["validBefore"]),
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
