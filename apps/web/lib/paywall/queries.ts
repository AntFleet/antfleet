// Paywall-specific DB helpers. Kept in lib/paywall/ rather than db/queries.ts
// to keep the paywall surface independently scannable; nothing here is
// reused by the legacy gate flow.

import { sql } from "drizzle-orm";
import { db } from "@/db";

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
  return row;
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
  return firstRow<PaywallInstallationRow>(result);
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
  return firstRow<PaywallChannelRow>(result);
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
    ON CONFLICT (chain_id, tx_hash) DO NOTHING
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

function firstRow<T>(result: unknown): T | null {
  const rows = Array.isArray(result)
    ? result
    : Array.isArray((result as { rows?: unknown[] }).rows)
      ? (result as { rows: unknown[] }).rows
      : [];
  return (rows[0] as T | undefined) ?? null;
}
