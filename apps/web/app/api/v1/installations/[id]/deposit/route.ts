// POST /api/v1/installations/{id}/deposit — verify an on-chain USDC
// deposit on Base, create the channel if it doesn't exist yet, credit the
// channel atomically, and transition the row to `active`. Idempotent: a
// replayed tx_hash hits the (chain_id, tx_hash) unique index in payments
// and the channel balance is NOT bumped again.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { jsonError, jsonOk, NO_STORE, optionsResponse } from "@/lib/api-v1/responses";
import { logError, logInfo, logWarn } from "@/lib/log";
import {
  createChannelForInstallation,
  creditChannelFromDeposit,
  loadChannelForInstallation,
  loadPaywallInstallation,
  markInstallationActiveIfFunded,
  type PaywallChannelRow,
  type PaywallInstallationRow,
} from "@/lib/paywall/queries";
import { buildNextStep } from "@/lib/paywall/next-step";
import { PAYWALL_STATUS } from "@/lib/paywall/state";
import { BASE_CHAIN_ID, getDepositAddress, getMinDepositUsdc } from "@/lib/paywall/env";
import {
  defaultDepositVerifierDeps,
  verifyDeposit,
  type DepositVerifierDeps,
  type VerifyDepositError,
  type VerifiedDeposit,
} from "@/lib/paywall/deposit-verifier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  tx_hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "tx_hash must be 0x + 64 hex"),
});

export type DepositInstallationDeps = {
  loadInstallation: (id: string) => Promise<PaywallInstallationRow | null>;
  loadChannel: (id: string) => Promise<PaywallChannelRow | null>;
  createChannel: (args: { installationRowId: string; walletAddress: string }) => Promise<string>;
  creditDeposit: (args: {
    channelId: string;
    txHash: string;
    chainId: number;
    fromAddress: string;
    amountUsdc: string;
    blockNumber: number | null;
  }) => Promise<boolean>;
  markActiveIfFunded: (args: {
    installationRowId: string;
    minBalanceUsdc: string;
  }) => Promise<boolean>;
  verifier: DepositVerifierDeps;
  getDepositAddress: () => string | null;
  getMinDeposit: () => string;
};

function defaultDeps(): DepositInstallationDeps {
  return {
    loadInstallation: (id) => loadPaywallInstallation(db, id),
    loadChannel: (id) => loadChannelForInstallation(db, id),
    createChannel: (args) => createChannelForInstallation(db, args),
    creditDeposit: (args) => creditChannelFromDeposit(db, args),
    markActiveIfFunded: (args) => markInstallationActiveIfFunded(db, args),
    verifier: defaultDepositVerifierDeps(),
    getDepositAddress,
    getMinDeposit: getMinDepositUsdc,
  };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleDepositInstallation(req, ctx, defaultDeps());
}

export function OPTIONS() {
  return optionsResponse();
}

export async function handleDepositInstallation(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
  deps: DepositInstallationDeps,
) {
  try {
    const { id } = await ctx.params;
    const parsed = bodySchema.safeParse(await readJson(req));
    if (!parsed.success) {
      logWarn("paywall.deposit.rejected", { reason: "bad-request", id });
      return jsonError(400, "invalid_input", parsed.error.issues[0]?.message ?? "bad request");
    }
    const depositAddress = deps.getDepositAddress();
    if (depositAddress === null) {
      logError("paywall.deposit.misconfigured", { reason: "ANTFLEET_DEPOSIT_ADDRESS missing" });
      return jsonError(
        503,
        "deposit_address_unconfigured",
        "operator has not configured ANTFLEET_DEPOSIT_ADDRESS yet",
      );
    }

    const row = await deps.loadInstallation(id);
    if (row === null) {
      return jsonError(404, "not_found", "installation not found");
    }
    // Deposits are accepted in awaiting_deposit (first deposit) and in
    // active (top-up after a channel was depleted by drawdowns). They are
    // rejected in pending_binding because we do not yet trust the wallet.
    if (row.status !== PAYWALL_STATUS.awaitingDeposit && row.status !== PAYWALL_STATUS.active) {
      return jsonError(
        409,
        "wrong_status",
        `installation is ${row.status}; bind wallet before depositing`,
      );
    }
    if (row.walletAddress === null) {
      return jsonError(409, "no_wallet", "installation has no bound wallet");
    }

    const verification = await verifyDeposit(deps.verifier, {
      txHash: parsed.data.tx_hash,
      expectedFrom: row.walletAddress,
      depositAddress,
      minDepositUsdc: deps.getMinDeposit(),
    });
    if (!verification.ok) {
      logWarn("paywall.deposit.verify_failed", {
        id,
        code: verification.error.code,
        message: verification.error.message,
      });
      return jsonError(
        statusForVerifyDepositError(verification.error),
        verification.error.code,
        verification.error.message,
      );
    }

    const channel = await ensureChannel(deps, row);
    const credited = await deps.creditDeposit({
      channelId: channel.id,
      txHash: verification.deposit.txHash,
      chainId: BASE_CHAIN_ID,
      fromAddress: verification.deposit.fromAddress,
      amountUsdc: verification.deposit.amountUsdc,
      blockNumber: verification.deposit.blockNumber,
    });
    let status =
      credited || row.status === PAYWALL_STATUS.active ? PAYWALL_STATUS.active : row.status;
    if (!credited && status !== PAYWALL_STATUS.active) {
      const activated = await deps.markActiveIfFunded({
        installationRowId: row.id,
        minBalanceUsdc: deps.getMinDeposit(),
      });
      if (!activated) {
        return jsonError(
          409,
          "deposit_already_recorded",
          "deposit transaction was already recorded and did not fund this installation",
        );
      }
      status = PAYWALL_STATUS.active;
    }

    logInfo("paywall.deposit.ok", {
      installationId: row.id,
      channelId: channel.id,
      txHash: verification.deposit.txHash,
      amountUsdc: verification.deposit.amountUsdc,
      credited,
    });

    return jsonOk(
      {
        installation_id: row.id,
        status,
        wallet_address: row.walletAddress,
        deposit: {
          tx_hash: verification.deposit.txHash,
          chain_id: BASE_CHAIN_ID,
          amount_usdc: verification.deposit.amountUsdc,
          credited,
        },
        channel: { id: channel.id },
        next_step: buildNextStep({
          status: row.installationId === null ? status : "linked",
          installationId: row.id,
        }),
      },
      { cacheControl: NO_STORE },
    );
  } catch (err) {
    logError("paywall.deposit.internal", {
      message: err instanceof Error ? err.message : String(err),
    });
    return jsonError(500, "internal", "internal error");
  }
}

async function ensureChannel(
  deps: DepositInstallationDeps,
  row: PaywallInstallationRow,
): Promise<PaywallChannelRow> {
  if (row.walletAddress === null) {
    throw new Error("ensureChannel called for row without walletAddress");
  }
  const existing = await deps.loadChannel(row.id);
  if (existing !== null) return existing;
  await deps.createChannel({ installationRowId: row.id, walletAddress: row.walletAddress });
  const created = await deps.loadChannel(row.id);
  if (created === null) {
    throw new Error("channel insert succeeded but row could not be loaded");
  }
  return created;
}

// Expose for the scan-deposits cron in PR #3 — same body shape, same idempotency.
export type { VerifiedDeposit };

function statusForVerifyDepositError(error: VerifyDepositError): 400 | 503 {
  return error.code === "rpc_unavailable" ? 503 : 400;
}

async function readJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
