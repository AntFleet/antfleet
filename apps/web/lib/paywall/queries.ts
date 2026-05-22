// Paywall-specific DB helpers. Kept in lib/paywall/ rather than db/queries.ts
// to keep the paywall surface independently scannable; nothing here is
// reused by the legacy gate flow.

import { sql } from "drizzle-orm";
import { db } from "@/db";

// Neon's serverless driver returns `timestamp with time zone` columns as
// ISO-8601 strings, not Date objects. Our row types declare these fields as
// `Date` (which matches what Drizzle's typed-select API would yield), so any
// caller that hits `.getTime()` or `.toISOString()` on a freshly-loaded row
// crashes with "X.getTime is not a function" / "X.toISOString is not a
// function". `parseDate` normalizes both shapes so the runtime values match
// the declared types — used by every loader below that returns a timestamp
// field. Long-term fix is to migrate these queries to the typed-select API;
// this is the hotfix.
function parseDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  throw new Error(`expected Date or ISO string, got ${typeof value}`);
}

function parseDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return parseDate(value);
}

export type PaywallInstallationRow = {
  id: string;
  status: string;
  walletAddress: string | null;
  walletProofSignature: string | null;
  walletBoundAt: Date | null;
  legacyPartner: boolean;
  installationId: number | null;
  owner: string | null;
  repo: string | null;
  createdAt: Date;
};

export type PaywallChannelRow = {
  id: string;
  installationId: string;
  walletAddress: string;
  balanceUsdc: string;
  createdAt: Date;
  lastDepositTxHash: string | null;
  lastDrawdownAt: Date | null;
};

type Queryable = Pick<typeof db, "execute">;

export async function insertPaywallInstallation(
  q: Queryable,
  args: { walletAddress: string },
): Promise<PaywallInstallationRow> {
  // wallet_address is stored on creation as a claim (the agent declares
  // which wallet they intend to bind); wallet_proof_signature / wallet_bound_at
  // remain NULL until the bind endpoint verifies an EIP-191 signature over
  // the canonical challenge. The challenge string embeds wallet_address,
  // so storing it now lets the bind endpoint reconstruct the exact message
  // without a separate challenge table.
  const result = await q.execute(sql`
    INSERT INTO installations ("status", "wallet_address")
    VALUES ('pending_binding', ${args.walletAddress.toLowerCase()})
    RETURNING
      id,
      status,
      wallet_address AS "walletAddress",
      wallet_proof_signature AS "walletProofSignature",
      wallet_bound_at AS "walletBoundAt",
      legacy_partner AS "legacyPartner",
      installation_id AS "installationId",
      owner,
      repo,
      created_at AS "createdAt"
  `);
  const row = firstRow<PaywallInstallationRow>(result);
  if (row === null) throw new Error("insert returned no row");
  return {
    ...row,
    walletBoundAt: parseDateOrNull(row.walletBoundAt),
    createdAt: parseDate(row.createdAt),
  };
}

export async function loadPaywallInstallation(
  q: Queryable,
  installationRowId: string,
): Promise<PaywallInstallationRow | null> {
  const result = await q.execute(sql`
    SELECT
      id,
      status,
      wallet_address AS "walletAddress",
      wallet_proof_signature AS "walletProofSignature",
      wallet_bound_at AS "walletBoundAt",
      legacy_partner AS "legacyPartner",
      installation_id AS "installationId",
      owner,
      repo,
      created_at AS "createdAt"
    FROM installations
    WHERE id = ${installationRowId}
    LIMIT 1
  `);
  const row = firstRow<PaywallInstallationRow>(result);
  if (row === null) return null;
  return {
    ...row,
    walletBoundAt: parseDateOrNull(row.walletBoundAt),
    createdAt: parseDate(row.createdAt),
  };
}

export async function markPaywallBound(
  q: Queryable,
  args: {
    installationRowId: string;
    walletAddress: string;
    signature: string;
    boundAt: Date;
  },
): Promise<void> {
  await q.execute(sql`
    UPDATE installations
    SET
      wallet_address = ${args.walletAddress},
      wallet_proof_signature = ${args.signature},
      wallet_bound_at = ${args.boundAt},
      status = 'awaiting_deposit'
    WHERE id = ${args.installationRowId}
      AND status = 'pending_binding'
  `);
}

export async function loadChannelForInstallation(
  q: Queryable,
  installationRowId: string,
): Promise<PaywallChannelRow | null> {
  const result = await q.execute(sql`
    SELECT
      id,
      installation_id AS "installationId",
      wallet_address AS "walletAddress",
      balance_usdc::text AS "balanceUsdc",
      created_at AS "createdAt",
      last_deposit_tx_hash AS "lastDepositTxHash",
      last_drawdown_at AS "lastDrawdownAt"
    FROM channels
    WHERE installation_id = ${installationRowId}
    LIMIT 1
  `);
  const row = firstRow<PaywallChannelRow>(result);
  if (row === null) return null;
  return {
    ...row,
    createdAt: parseDate(row.createdAt),
    lastDrawdownAt: parseDateOrNull(row.lastDrawdownAt),
  };
}

// Credits a channel from an on-chain deposit. Idempotent on (chainId, txHash):
// if the payment row already exists, the channel balance is NOT bumped again
// — the unique partial index on payments(chain_id, tx_hash) is the lock.
// Returns true if the deposit was credited (first observation), false if it
// was already recorded.
export async function creditChannelFromDeposit(
  q: Queryable,
  args: {
    channelId: string;
    txHash: string;
    chainId: number;
    fromAddress: string;
    amountUsdc: string;
    blockNumber: number | null;
  },
): Promise<boolean> {
  // The conflict target MUST include the partial index's predicate
  // (WHERE tx_hash IS NOT NULL) so Postgres matches `payments_tx_hash_uniq`.
  // Without the predicate, Postgres raises:
  //   "there is no unique or exclusion constraint matching the ON CONFLICT
  //    specification"
  // This was a latent prod bug in the paywall MVP — discovered the first
  // time a real agent tried to credit a deposit (2026-05-22).
  const insertResult = await q.execute(sql`
    INSERT INTO payments (channel_id, type, tx_hash, chain_id, from_address, amount_usdc, block_number)
    VALUES (
      ${args.channelId},
      'deposit',
      ${args.txHash},
      ${args.chainId},
      ${args.fromAddress.toLowerCase()},
      ${args.amountUsdc},
      ${args.blockNumber}
    )
    ON CONFLICT (chain_id, tx_hash) WHERE tx_hash IS NOT NULL DO NOTHING
    RETURNING id
  `);
  const inserted = firstRow<{ id: string }>(insertResult);
  if (inserted === null) return false;
  await q.execute(sql`
    UPDATE channels
    SET
      balance_usdc = balance_usdc + ${args.amountUsdc}::numeric,
      last_deposit_tx_hash = ${args.txHash}
    WHERE id = ${args.channelId}
  `);
  return true;
}

// Creates a channel for an installation row. Returns the row id. Unique
// constraint on channels(installation_id) means a second call for the same
// installation will fail with 23505 — callers should use this only on the
// first deposit for an awaiting_deposit row.
export async function createChannelForInstallation(
  q: Queryable,
  args: { installationRowId: string; walletAddress: string },
): Promise<string> {
  const result = await q.execute(sql`
    INSERT INTO channels (installation_id, wallet_address)
    VALUES (${args.installationRowId}, ${args.walletAddress.toLowerCase()})
    ON CONFLICT (installation_id) DO UPDATE SET wallet_address = EXCLUDED.wallet_address
    RETURNING id
  `);
  const row = firstRow<{ id: string }>(result);
  if (row === null) throw new Error("channel insert returned no row");
  return row.id;
}

export async function markInstallationActive(
  q: Queryable,
  installationRowId: string,
): Promise<void> {
  await q.execute(sql`
    UPDATE installations
    SET status = 'active'
    WHERE id = ${installationRowId}
      AND status IN ('awaiting_deposit', 'active')
  `);
}

// Settlement context for a paid review — the post-debit channel balance
// and the last on-chain deposit tx hash. Used by the review-worker to
// append a "Settled · tx … · channel balance …" footer to the PR comment.
// Returns null when the review row has no linked drawdown (legacy_partner
// installs, or pre-paywall reviews).
export type ReviewSettlement = {
  channelBalanceUsdc: string;
  lastDepositTxHash: string | null;
};

export async function loadReviewSettlement(
  q: Queryable,
  reviewId: string,
): Promise<ReviewSettlement | null> {
  const result = await q.execute(sql`
    SELECT
      c.balance_usdc::text AS "channelBalanceUsdc",
      c.last_deposit_tx_hash AS "lastDepositTxHash"
    FROM payments p
    JOIN channels c ON c.id = p.channel_id
    WHERE p.review_id = ${reviewId} AND p.type = 'drawdown'
    LIMIT 1
  `);
  return firstRowPaywall<ReviewSettlement>(result);
}

function firstRowPaywall<T>(result: unknown): T | null {
  const rows = Array.isArray(result)
    ? result
    : Array.isArray((result as { rows?: unknown[] }).rows)
      ? (result as { rows: unknown[] }).rows
      : [];
  return (rows[0] as T | undefined) ?? null;
}

// Aggregates everything a wallet has done through the paywall: every
// installation it owns, the channel balances, the total USDC settled via
// drawdown, the review + finding-close counts. One query per metric to keep
// the SQL legible; the wallets/[address] page renders a single wallet so
// the four extra round-trips are not a hot-path concern.
export type WalletReputation = {
  walletAddress: string;
  totalReviews: number;
  findingsTotal: number;
  findingsClosed: number;
  // Patch Agent v1.5 — patches proposed by the suggested-patch reviewer
  // lane and patches accepted (detected by the sweeper at HEAD on the
  // default branch). Aggregated across every installation bound to the
  // wallet. Always populated (zero when the patch lane never ran on a
  // wallet's installs).
  patchesProposed: number;
  patchesAccepted: number;
  // Patch Agent v1.6 — subset of patchesAccepted where the maintainer
  // clicked GitHub's "Commit suggestion" button (sweeper's apply-detection
  // pass observed the commit_id advance + content match). Always ≤ patchesAccepted.
  patchClickApplies: number;
  totalSettledUsdc: string;
  currentBalanceUsdc: string;
  installations: Array<{
    installationRowId: string;
    githubInstallationId: number | null;
    owner: string | null;
    repo: string | null;
    status: string;
    channelBalanceUsdc: string | null;
    boundAt: Date | null;
  }>;
};

type Q = Pick<typeof db, "execute">;

export async function loadWalletReputation(
  q: Q,
  walletAddress: string,
): Promise<WalletReputation | null> {
  const wallet = walletAddress.toLowerCase();
  const installRows = await q.execute(sql`
    SELECT
      i.id AS "installationRowId",
      i.installation_id AS "githubInstallationId",
      i.owner,
      i.repo,
      i.status,
      i.wallet_bound_at AS "boundAt",
      c.balance_usdc::text AS "channelBalanceUsdc"
    FROM installations i
    LEFT JOIN channels c ON c.installation_id = i.id
    WHERE i.wallet_address = ${wallet}
    ORDER BY i.created_at DESC
  `);
  const installationsRaw = rowsOf<{
    installationRowId: string;
    githubInstallationId: number | null;
    owner: string | null;
    repo: string | null;
    status: string;
    boundAt: Date | null;
    channelBalanceUsdc: string | null;
  }>(installRows);
  if (installationsRaw.length === 0) return null;
  // Normalize timestamp strings → Date (Neon serverless returns ISO strings).
  const installations = installationsRaw.map((i) => ({
    ...i,
    boundAt: parseDateOrNull(i.boundAt),
  }));

  const ghIds = installations
    .map((i) => i.githubInstallationId)
    .filter((id): id is number => id !== null);

  let totalReviews = 0;
  let findingsTotal = 0;
  let findingsClosed = 0;
  let patchesProposed = 0;
  let patchesAccepted = 0;
  let patchClickApplies = 0;

  if (ghIds.length > 0) {
    // reviews table uses installation_id (the GitHub install bigint), not
    // the installations table PK. Aggregate across every github id the
    // wallet owns.
    const reviewStats = await q.execute(sql`
      SELECT count(*)::int AS "value"
      FROM reviews
      WHERE installation_id = ANY (${ghIds}::bigint[])
    `);
    totalReviews = Number(firstRow<{ value: number | string }>(reviewStats)?.value ?? 0);

    // Patch Agent v1.5 — fold the per-finding patch lifecycle into the
    // same scan. patches_proposed gates on patch_proposed_at (set by the
    // worker when a suggestion ships); patches_accepted gates on
    // patch_accepted_at (set by the sweeper). Both are observability-only;
    // the close-rate metric is unaffected.
    const findingStats = await q.execute(sql`
      SELECT
        count(*)::int AS "total",
        count(*) FILTER (WHERE fs.status = 'closed')::int AS "closed",
        count(*) FILTER (WHERE fs.patch_proposed_at IS NOT NULL)::int AS "patchesProposed",
        count(*) FILTER (WHERE fs.patch_accepted_at IS NOT NULL)::int AS "patchesAccepted",
        count(*) FILTER (WHERE fs.patch_apply_clicked_at IS NOT NULL)::int AS "patchClickApplies"
      FROM finding_status fs
      JOIN reviews r ON r.review_id = fs.review_id
      WHERE r.installation_id = ANY (${ghIds}::bigint[])
    `);
    const f = firstRow<{
      total: number | string;
      closed: number | string;
      patchesProposed: number | string;
      patchesAccepted: number | string;
      patchClickApplies: number | string;
    }>(findingStats);
    findingsTotal = Number(f?.total ?? 0);
    findingsClosed = Number(f?.closed ?? 0);
    patchesProposed = Number(f?.patchesProposed ?? 0);
    patchesAccepted = Number(f?.patchesAccepted ?? 0);
    patchClickApplies = Number(f?.patchClickApplies ?? 0);
  }

  const settledResult = await q.execute(sql`
    SELECT coalesce(sum(amount_usdc), 0)::text AS "value"
    FROM payments p
    JOIN channels c ON c.id = p.channel_id
    WHERE c.wallet_address = ${wallet} AND p.type = 'drawdown'
  `);
  const totalSettledUsdc = String(firstRow<{ value: string }>(settledResult)?.value ?? "0");

  const balanceResult = await q.execute(sql`
    SELECT coalesce(sum(balance_usdc), 0)::text AS "value"
    FROM channels
    WHERE wallet_address = ${wallet}
  `);
  const currentBalanceUsdc = String(firstRow<{ value: string }>(balanceResult)?.value ?? "0");

  return {
    walletAddress: wallet,
    totalReviews,
    findingsTotal,
    findingsClosed,
    patchesProposed,
    patchesAccepted,
    patchClickApplies,
    totalSettledUsdc,
    currentBalanceUsdc,
    installations,
  };
}

// Full review payload for the synchronous /api/v1/installations/{id}/review
// endpoint. The webhook path's after() runs runReviewWorker async and
// never reads back; the on-demand path awaits the worker and then loads
// these fields to compose its response. agreementDecision.agreed lives
// in the reviews JSONB (set by review-worker's updateReview call); the
// findingIds come from finding_status (set by recordFindingStatuses).
export type ReviewResponsePayload = {
  reviewId: string;
  installationId: number | null;
  owner: string | null;
  repo: string | null;
  prNumber: number;
  commitSha: string;
  agreementDecision: unknown;
  publicReceipt: boolean;
  isBenchmark: boolean;
  prCommentUrl: string | null;
  processingStatus: string;
  processingError: string | null;
  timingMs: number;
  costEstimatedUsd: string;
  findingIds: string[];
};

export async function loadReviewForResponse(
  q: Queryable,
  reviewId: string,
): Promise<ReviewResponsePayload | null> {
  const result = await q.execute(sql`
    SELECT
      r.review_id AS "reviewId",
      r.installation_id AS "installationId",
      r.owner,
      r.repo,
      r.pr_number AS "prNumber",
      r.commit_sha AS "commitSha",
      r.agreement_decision AS "agreementDecision",
      r.public_receipt AS "publicReceipt",
      r.is_benchmark AS "isBenchmark",
      r.pr_comment_url AS "prCommentUrl",
      r.processing_status AS "processingStatus",
      r.processing_error AS "processingError",
      r.timing_ms AS "timingMs",
      r.cost_estimated_usd::text AS "costEstimatedUsd",
      COALESCE(
        ARRAY(
          SELECT finding_id
          FROM finding_status
          WHERE review_id = r.review_id
          ORDER BY finding_index
        ),
        ARRAY[]::text[]
      ) AS "findingIds"
    FROM reviews r
    WHERE r.review_id = ${reviewId}
    LIMIT 1
  `);
  return firstRow<ReviewResponsePayload>(result);
}

// Read current channel balance for response composition. Used by the
// on-demand review endpoint to surface { remaining_usdc } regardless of
// whether the request hit the debit path or the cached path. Returns
// null when the installation has no channel (legacy_partner installs).
export async function loadChannelBalanceForInstallation(
  q: Queryable,
  installationRowId: string,
): Promise<string | null> {
  const result = await q.execute(sql`
    SELECT balance_usdc::text AS "balanceUsdc"
    FROM channels
    WHERE installation_id = ${installationRowId}
    LIMIT 1
  `);
  const row = firstRow<{ balanceUsdc: string }>(result);
  return row?.balanceUsdc ?? null;
}

// review_challenges helpers. Server-issued single-use nonces backing the
// on-demand /api/v1/installations/{id}/review endpoint. The /bind endpoint
// uses a stateless challenge (derived from installations.created_at), safe
// because binding is one-shot per install. Review is repeating, so each
// trigger mints a fresh row here and marks used_at on redemption — this
// is the anti-replay surface.

export type ReviewChallengeRow = {
  id: string;
  installationRowId: string;
  issuedAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  usedForReviewId: string | null;
};

export async function insertReviewChallenge(
  q: Queryable,
  args: { installationRowId: string; issuedAt: Date; expiresAt: Date },
): Promise<ReviewChallengeRow> {
  const result = await q.execute(sql`
    INSERT INTO review_challenges (
      installation_row_id,
      issued_at,
      expires_at
    )
    VALUES (
      ${args.installationRowId},
      ${args.issuedAt},
      ${args.expiresAt}
    )
    RETURNING
      id,
      installation_row_id AS "installationRowId",
      issued_at AS "issuedAt",
      expires_at AS "expiresAt",
      used_at AS "usedAt",
      used_for_review_id AS "usedForReviewId"
  `);
  const row = firstRow<ReviewChallengeRow>(result);
  if (row === null) throw new Error("review_challenges insert returned no row");
  return parseReviewChallengeRow(row);
}

export async function loadReviewChallenge(
  q: Queryable,
  challengeId: string,
): Promise<ReviewChallengeRow | null> {
  const result = await q.execute(sql`
    SELECT
      id,
      installation_row_id AS "installationRowId",
      issued_at AS "issuedAt",
      expires_at AS "expiresAt",
      used_at AS "usedAt",
      used_for_review_id AS "usedForReviewId"
    FROM review_challenges
    WHERE id = ${challengeId}
    LIMIT 1
  `);
  const row = firstRow<ReviewChallengeRow>(result);
  if (row === null) return null;
  return parseReviewChallengeRow(row);
}

function parseReviewChallengeRow(row: ReviewChallengeRow): ReviewChallengeRow {
  return {
    ...row,
    issuedAt: parseDate(row.issuedAt),
    expiresAt: parseDate(row.expiresAt),
    usedAt: parseDateOrNull(row.usedAt),
  };
}

// Atomically claims a challenge. The WHERE clause on used_at IS NULL is
// the race-safe anti-replay guard: two concurrent verifications for the
// same challenge_id will see the second UPDATE return 0 rows, and the
// loser returns 401 challenge_already_used. Called BEFORE enqueueReview
// so a lost-race redemption doesn't leave a stale reviews row behind
// (the prior order — enqueue then mark — was clean for billing but left
// audit cruft on each race loss; see code review feedback on PR #48).
//
// used_for_review_id is filled in by linkReviewChallengeToReview after
// enqueueReview returns. The brief window between claim and link is
// audit-only — the race guard above already lives in used_at.
export async function claimReviewChallenge(
  q: Queryable,
  args: { challengeId: string; usedAt: Date },
): Promise<boolean> {
  const result = await q.execute(sql`
    UPDATE review_challenges
    SET used_at = ${args.usedAt}
    WHERE id = ${args.challengeId}
      AND used_at IS NULL
    RETURNING id
  `);
  return firstRow<{ id: string }>(result) !== null;
}

// Audit-only link from the claimed challenge to its review row. Called
// after enqueueReview returns the reviewId. Best-effort: if this UPDATE
// fails, the challenge is still marked used (the race guard) and the
// review still proceeds; the link is recoverable from the reviews row's
// created_at + the challenge's used_at.
export async function linkReviewChallengeToReview(
  q: Queryable,
  args: { challengeId: string; reviewId: string },
): Promise<void> {
  await q.execute(sql`
    UPDATE review_challenges
    SET used_for_review_id = ${args.reviewId}
    WHERE id = ${args.challengeId}
      AND used_for_review_id IS NULL
  `);
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
