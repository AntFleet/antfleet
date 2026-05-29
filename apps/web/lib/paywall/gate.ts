// Webhook drawdown gate. Called by the GitHub App pull_request handler
// after signature verification and before review enqueue. Decides one of
// four outcomes for an incoming PR webhook:
//
//   not_installed → no install row matches (installation_id, repo). Caller
//                   should no-op the webhook (the GitHub App is installed
//                   on a repo we never saw or that was rejected).
//   bypass        → legacy_partner row. Skip balance check, proceed to
//                   enqueue.
//   insufficient  → paywall row with balance < REVIEW_PRICE_USDC. Caller
//                   should post the prepaid-channel top-up invoice and skip enqueue.
//   debit         → balance ≥ price. Caller calls debitChannel() before
//                   enqueueing; debitChannel is an atomic CAS so concurrent
//                   webhooks for the same channel cannot overdraw.

import { sql } from "drizzle-orm";
import { db } from "@/db";
import { compareUsdcStrings, parseUsdcUnits } from "@/lib/paywall/deposit-verifier";
import { getReviewPriceUsdc } from "@/lib/paywall/env";
import { logError } from "@/lib/log";

type Queryable = Pick<typeof db, "execute">;

export type GateDecision =
  | { kind: "not_installed" }
  | { kind: "bypass"; installationRowId: string }
  | {
      kind: "insufficient";
      installationRowId: string;
      channelId: string;
      balanceUsdc: string;
      priceUsdc: string;
      walletAddress: string;
    }
  | {
      kind: "debit";
      installationRowId: string;
      channelId: string;
      balanceUsdc: string;
      priceUsdc: string;
      walletAddress: string;
    };

type InstallationGateRow = {
  id: string;
  status: string;
  legacyPartner: boolean;
  walletAddress: string | null;
  channelId: string | null;
  channelBalanceUsdc: string | null;
};

export type GateDeps = {
  loadInstallationGateRow: (
    installationId: number,
    repo: string,
  ) => Promise<InstallationGateRow | null>;
  getPriceUsdc: () => string;
};

const DEFAULT_DEPS: GateDeps = {
  loadInstallationGateRow: (installationId, repo) =>
    loadInstallationGateRow(db, installationId, repo),
  getPriceUsdc: getReviewPriceUsdc,
};

export async function decideGate(
  args: { installationId: number; repo: string },
  deps: GateDeps = DEFAULT_DEPS,
): Promise<GateDecision> {
  const row = await deps.loadInstallationGateRow(args.installationId, args.repo);
  if (row === null) return { kind: "not_installed" };
  if (row.legacyPartner) {
    return { kind: "bypass", installationRowId: row.id };
  }
  // Non-legacy rows MUST be in the paywall flow. status='active' is the
  // only state a webhook should land on; pending_binding / awaiting_deposit
  // never get here because they have no installation_id. Treat anything
  // else (status='approved' without legacy_partner=true, or any unknown
  // status) as not-installed so the webhook no-ops without crashing.
  if (row.status !== "active") return { kind: "not_installed" };
  if (row.walletAddress === null || row.channelId === null || row.channelBalanceUsdc === null) {
    return { kind: "not_installed" };
  }
  const priceUsdc = deps.getPriceUsdc();
  const cmp = compareUsdcStrings(row.channelBalanceUsdc, priceUsdc);
  if (cmp < 0) {
    return {
      kind: "insufficient",
      installationRowId: row.id,
      channelId: row.channelId,
      balanceUsdc: row.channelBalanceUsdc,
      priceUsdc,
      walletAddress: row.walletAddress,
    };
  }
  return {
    kind: "debit",
    installationRowId: row.id,
    channelId: row.channelId,
    balanceUsdc: row.channelBalanceUsdc,
    priceUsdc,
    walletAddress: row.walletAddress,
  };
}

export async function loadInstallationGateRow(
  q: Queryable,
  installationId: number,
  repo: string,
): Promise<InstallationGateRow | null> {
  const result = await q.execute(sql`
    SELECT
      i.id AS "id",
      i.status AS "status",
      i.legacy_partner AS "legacyPartner",
      i.wallet_address AS "walletAddress",
      c.id AS "channelId",
      c.balance_usdc::text AS "channelBalanceUsdc"
    FROM installations i
    LEFT JOIN channels c ON c.installation_id = i.id
    WHERE i.installation_id = ${installationId}
      AND i.repo = ${repo}
    LIMIT 1
  `);
  return firstRow<InstallationGateRow>(result);
}

// Atomic check-and-debit. `UPDATE ... SET balance = balance - price WHERE
// id = ? AND balance >= price` is the textbook race-free pattern in
// Postgres; the row lock for the duration of the UPDATE serializes
// concurrent debits, and the WHERE clause guarantees the balance never
// goes negative even if two webhooks observe `balance == price - epsilon`
// in their initial reads. Returns the new balance on success, null on
// insufficient funds. Idempotency: a caller that retries the same debit
// will double-debit — only call exactly once per intended review.
export async function debitChannel(
  q: Queryable,
  args: { channelId: string; priceUsdc: string },
): Promise<{ newBalanceUsdc: string } | null> {
  const result = await q.execute(sql`
    UPDATE channels
    SET
      balance_usdc = balance_usdc - ${args.priceUsdc}::numeric,
      last_drawdown_at = now()
    WHERE id = ${args.channelId}
      AND balance_usdc >= ${args.priceUsdc}::numeric
    RETURNING balance_usdc::text AS "newBalanceUsdc"
  `);
  return firstRow<{ newBalanceUsdc: string }>(result);
}

// Records the drawdown ledger entry for an already-debited channel.
// Called immediately after debitChannel() succeeds and enqueueReview()
// returns a reviewId. Best-effort: if this throws, the debit is still
// recorded in channels.balance_usdc but the per-review link is lost —
// caller should log loudly. v1 trades a recovery hole here against the
// complexity of distributed transactions across the queue insert.
export async function recordDrawdown(
  q: Queryable,
  args: {
    channelId: string;
    reviewId: string;
    amountUsdc: string;
    fromAddress: string;
  },
): Promise<string> {
  const result = await q.execute(sql`
    INSERT INTO payments (channel_id, type, chain_id, from_address, amount_usdc, review_id)
    VALUES (
      ${args.channelId},
      'drawdown',
      8453,
      ${args.fromAddress.toLowerCase()},
      ${args.amountUsdc},
      ${args.reviewId}
    )
    RETURNING id
  `);
  const row = firstRow<{ id: string }>(result);
  if (row === null) throw new Error("drawdown insert returned no row");
  return row.id;
}

export async function recordJobDrawdown(
  q: Queryable,
  args: {
    channelId: string;
    amountUsdc: string;
    fromAddress: string;
  },
): Promise<string> {
  const result = await q.execute(sql`
    INSERT INTO payments (channel_id, type, chain_id, from_address, amount_usdc)
    VALUES (
      ${args.channelId},
      'drawdown',
      8453,
      ${args.fromAddress.toLowerCase()},
      ${args.amountUsdc}
    )
    RETURNING id
  `);
  const row = firstRow<{ id: string }>(result);
  if (row === null) throw new Error("job drawdown insert returned no row");
  return row.id;
}

// Shared debit-and-record helper used by both the GitHub webhook handler
// and the on-demand /api/v1/installations/{id}/review endpoint. Wraps the
// quantize → debitChannel (atomic CAS) → recordDrawdown sequence with the
// best-effort drawdown semantics the webhook has used since day one:
// if the ledger insert throws after the debit succeeded, we log loudly
// but DO NOT roll back the channel balance — the review is legitimately
// about to run and the operator can reconcile from channels + reviews if
// needed (same tradeoff documented in recordDrawdown itself).
//
// Returns a discriminated result so each surface chooses what to do with
// "insufficient_at_debit": the webhook posts an invoice PR comment; the
// API endpoint returns 402 JSON. Neither path changes the channel state
// on insufficient — debitChannel's WHERE clause is the source of truth.
export type DebitForReviewResult =
  | {
      ok: true;
      debitedUsdc: string;
      newBalanceUsdc: string;
      // null when the drawdown ledger insert failed after the debit
      // succeeded. Best-effort recovery: a follow-up sweep can re-link
      // the row if needed. The debit itself is durable in `channels`.
      drawdownId: string | null;
    }
  | { ok: false; reason: "insufficient_at_debit" };

export async function debitForReview(
  q: Queryable,
  args: {
    decision: Extract<GateDecision, { kind: "debit" }>;
    reviewId: string;
    logContext?: Record<string, unknown>;
  },
): Promise<DebitForReviewResult> {
  const priceUsdc = quantizeUsdc(args.decision.priceUsdc);
  const debited = await debitChannel(q, {
    channelId: args.decision.channelId,
    priceUsdc,
  });
  if (debited === null) {
    return { ok: false, reason: "insufficient_at_debit" };
  }
  let drawdownId: string | null = null;
  try {
    drawdownId = await recordDrawdown(q, {
      channelId: args.decision.channelId,
      reviewId: args.reviewId,
      amountUsdc: priceUsdc,
      fromAddress: args.decision.walletAddress,
    });
  } catch (err) {
    logError("paywall.gate.drawdown_record_failed", {
      ...args.logContext,
      reviewId: args.reviewId,
      channelId: args.decision.channelId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return {
    ok: true,
    debitedUsdc: priceUsdc,
    newBalanceUsdc: debited.newBalanceUsdc,
    drawdownId,
  };
}

export async function debitForJob(
  q: Queryable,
  args: {
    decision: Extract<GateDecision, { kind: "debit" }>;
    logContext?: Record<string, unknown>;
  },
): Promise<DebitForReviewResult> {
  const priceUsdc = quantizeUsdc(args.decision.priceUsdc);
  const debited = await debitChannel(q, {
    channelId: args.decision.channelId,
    priceUsdc,
  });
  if (debited === null) {
    return { ok: false, reason: "insufficient_at_debit" };
  }
  let drawdownId: string | null = null;
  try {
    drawdownId = await recordJobDrawdown(q, {
      channelId: args.decision.channelId,
      amountUsdc: priceUsdc,
      fromAddress: args.decision.walletAddress,
    });
  } catch (err) {
    logError("paywall.gate.job_drawdown_record_failed", {
      ...args.logContext,
      channelId: args.decision.channelId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return {
    ok: true,
    debitedUsdc: priceUsdc,
    newBalanceUsdc: debited.newBalanceUsdc,
    drawdownId,
  };
}

// Parses and re-formats so caller-facing API matches everywhere else.
export function quantizeUsdc(value: string): string {
  // Force a 6-decimal canonical form to keep payments.amount_usdc rows
  // consistent regardless of how the operator wrote REVIEW_PRICE_USDC.
  const units = parseUsdcUnits(value);
  const divisor = 10n ** 6n;
  const whole = units < 0n ? -units / divisor : units / divisor;
  const frac = (units < 0n ? -units : units) % divisor;
  const sign = units < 0n ? "-" : "";
  return `${sign}${whole.toString()}.${frac.toString().padStart(6, "0")}`;
}

function firstRow<T>(result: unknown): T | null {
  const rows = Array.isArray(result)
    ? result
    : Array.isArray((result as { rows?: unknown[] }).rows)
      ? (result as { rows: unknown[] }).rows
      : [];
  return (rows[0] as T | undefined) ?? null;
}
