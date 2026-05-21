// POST /api/v1/installations/{id}/bind — verify the agent's EIP-191
// signature over the binding challenge and transition the row from
// pending_binding to awaiting_deposit. wallet_address was stored at
// creation; this endpoint only verifies that the signature recovers to
// that exact address.

import type { NextRequest } from "next/server";
import { recoverMessageAddress as viemRecoverMessageAddress } from "viem";
import { z } from "zod";
import { db } from "@/db";
import { jsonError, jsonOk, NO_STORE, optionsResponse } from "@/lib/api-v1/responses";
import { logError, logInfo, logWarn } from "@/lib/log";
import {
  BINDING_CHALLENGE_FUTURE_SKEW_MS,
  BINDING_CHALLENGE_MAX_AGE_MS,
  buildBindingChallenge,
} from "@/lib/paywall/challenge";
import { buildNextStep } from "@/lib/paywall/next-step";
import {
  loadPaywallInstallation,
  markPaywallBound,
  type PaywallInstallationRow,
} from "@/lib/paywall/queries";
import { PAYWALL_STATUS } from "@/lib/paywall/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/, "signature must be 0x + 130 hex"),
});

export type BindInstallationDeps = {
  loadInstallation: (id: string) => Promise<PaywallInstallationRow | null>;
  recoverMessageAddress: (args: { message: string; signature: `0x${string}` }) => Promise<string>;
  markBound: (args: {
    installationRowId: string;
    walletAddress: string;
    signature: string;
    boundAt: Date;
  }) => Promise<void>;
  now: () => Date;
};

const DEFAULT_DEPS: BindInstallationDeps = {
  loadInstallation: (id) => loadPaywallInstallation(db, id),
  recoverMessageAddress: viemRecoverMessageAddress,
  markBound: (args) => markPaywallBound(db, args),
  now: () => new Date(),
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleBindInstallation(req, ctx, DEFAULT_DEPS);
}

export function OPTIONS() {
  return optionsResponse();
}

export async function handleBindInstallation(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
  deps: BindInstallationDeps,
) {
  try {
    const { id } = await ctx.params;
    const parsed = bodySchema.safeParse(await readJson(req));
    if (!parsed.success) {
      logWarn("paywall.bind.rejected", { reason: "bad-request", id });
      return jsonError(400, "invalid_input", parsed.error.issues[0]?.message ?? "bad request");
    }
    const row = await deps.loadInstallation(id);
    if (row === null) {
      return jsonError(404, "not_found", "installation not found");
    }
    if (row.status !== PAYWALL_STATUS.pendingBinding) {
      logWarn("paywall.bind.rejected", { reason: "wrong_status", id, status: row.status });
      return jsonError(
        409,
        "wrong_status",
        `installation is ${row.status}; binding is only valid in pending_binding`,
      );
    }
    if (row.walletAddress === null) {
      // Defensive — paywall rows always have wallet_address set at creation.
      return jsonError(409, "missing_wallet", "installation has no claimed wallet address");
    }

    const issuedAt = row.createdAt;
    const skewMs = issuedAt.getTime() - deps.now().getTime();
    if (skewMs > BINDING_CHALLENGE_FUTURE_SKEW_MS) {
      return jsonError(401, "stale_challenge", "binding challenge is from the future");
    }
    if (-skewMs > BINDING_CHALLENGE_MAX_AGE_MS) {
      return jsonError(
        401,
        "stale_challenge",
        "binding challenge has expired; create a new installation",
      );
    }

    const challenge = buildBindingChallenge({
      installationId: row.id,
      walletAddress: row.walletAddress,
      issuedAt,
    });

    let recovered: string;
    try {
      recovered = (
        await deps.recoverMessageAddress({
          message: challenge,
          signature: parsed.data.signature as `0x${string}`,
        })
      ).toLowerCase();
    } catch {
      return jsonError(400, "bad_signature", "could not recover address from signature");
    }

    if (recovered !== row.walletAddress) {
      logWarn("paywall.bind.rejected", {
        reason: "signature_mismatch",
        id,
        expected: row.walletAddress,
        recovered,
      });
      return jsonError(
        401,
        "signature_mismatch",
        "signature does not recover to the claimed wallet_address",
      );
    }

    const boundAt = deps.now();
    await deps.markBound({
      installationRowId: row.id,
      walletAddress: row.walletAddress,
      signature: parsed.data.signature,
      boundAt,
    });

    logInfo("paywall.bind.ok", { installationId: row.id, walletAddress: row.walletAddress });
    return jsonOk(
      {
        installation_id: row.id,
        status: PAYWALL_STATUS.awaitingDeposit,
        wallet_address: row.walletAddress,
        wallet_bound_at: boundAt.toISOString(),
        next_step: buildNextStep({
          status: PAYWALL_STATUS.awaitingDeposit,
          installationId: row.id,
        }),
      },
      { cacheControl: NO_STORE },
    );
  } catch (err) {
    logError("paywall.bind.internal", {
      message: err instanceof Error ? err.message : String(err),
    });
    return jsonError(500, "internal", "internal error");
  }
}

async function readJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
