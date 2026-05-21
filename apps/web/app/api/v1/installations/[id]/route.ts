// GET /api/v1/installations/{id} — read the current state of a paywall
// installation row + its computed next_step. Agents poll this when a write
// endpoint returns 4xx so they can self-correct without restarting the flow.

import { z } from "zod";
import {
  loadChannelForInstallation,
  loadPaywallInstallation,
  type PaywallChannelRow,
  type PaywallInstallationRow,
} from "@/lib/paywall/queries";
import { buildBindingChallenge } from "@/lib/paywall/challenge";
import { buildNextStep } from "@/lib/paywall/next-step";
import { PAYWALL_STATUS } from "@/lib/paywall/state";
import { db } from "@/db";
import { jsonError, jsonOk, NO_STORE, optionsResponse } from "@/lib/api-v1/responses";
import { logError } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuidSchema = z.string().uuid();

export type GetInstallationDeps = {
  loadInstallation: (id: string) => Promise<PaywallInstallationRow | null>;
  loadChannel: (installationRowId: string) => Promise<PaywallChannelRow | null>;
};

const DEFAULT_DEPS: GetInstallationDeps = {
  loadInstallation: (id) => loadPaywallInstallation(db, id),
  loadChannel: (id) => loadChannelForInstallation(db, id),
};

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleGetInstallation(ctx, DEFAULT_DEPS);
}

export function OPTIONS() {
  return optionsResponse();
}

export async function handleGetInstallation(
  ctx: { params: Promise<{ id: string }> },
  deps: GetInstallationDeps,
) {
  try {
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) {
      return jsonError(400, "invalid_input", "installation id must be a UUID");
    }
    const row = await deps.loadInstallation(id);
    if (row === null) {
      return jsonError(404, "not_found", "installation not found");
    }
    return jsonOk(serializeInstallation(row, await deps.loadChannel(id)), {
      cacheControl: NO_STORE,
    });
  } catch (err) {
    logError("paywall.get.internal", {
      message: err instanceof Error ? err.message : String(err),
    });
    return jsonError(500, "internal", "internal error");
  }
}

export function serializeInstallation(
  row: PaywallInstallationRow,
  channel: PaywallChannelRow | null,
): Record<string, unknown> {
  const base = {
    installation_id: row.id,
    status: row.status,
    wallet_address: row.walletAddress,
    wallet_bound_at: row.walletBoundAt?.toISOString() ?? null,
    legacy_partner: row.legacyPartner,
    github_installation_id: row.installationId,
    github_owner: row.owner,
    github_repo: row.repo,
    channel:
      channel === null
        ? null
        : {
            id: channel.id,
            balance_usdc: channel.balanceUsdc,
            last_deposit_tx_hash: channel.lastDepositTxHash,
            last_drawdown_at: channel.lastDrawdownAt?.toISOString() ?? null,
          },
    next_step: computeNextStep(row),
  };
  return base;
}

function computeNextStep(row: PaywallInstallationRow): ReturnType<typeof buildNextStep> {
  switch (row.status) {
    case PAYWALL_STATUS.pendingBinding: {
      // Reconstruct the challenge from the row so a GET poll returns the
      // same instructions as the initial create. createdAt is used as the
      // issuedAt anchor — the bind endpoint re-checks skew against now.
      const challenge = buildBindingChallenge({
        installationId: row.id,
        walletAddress: row.walletAddress ?? "0x0000000000000000000000000000000000000000",
        issuedAt: row.createdAt,
      });
      return buildNextStep({
        status: PAYWALL_STATUS.pendingBinding,
        installationId: row.id,
        challenge,
      });
    }
    case PAYWALL_STATUS.awaitingDeposit:
      return buildNextStep({ status: PAYWALL_STATUS.awaitingDeposit, installationId: row.id });
    case PAYWALL_STATUS.active:
      return row.installationId === null
        ? buildNextStep({ status: PAYWALL_STATUS.active, installationId: row.id })
        : buildNextStep({ status: "linked", installationId: row.id });
    default:
      // Legacy rows (pending_approval / approved / rejected) — surface a
      // benign next_step that just points back at this endpoint. The agent
      // surface is not meant for these rows; they're returned for parity
      // so operator scripts can hit GET without 404ing.
      return buildNextStep({ status: "linked", installationId: row.id });
  }
}
