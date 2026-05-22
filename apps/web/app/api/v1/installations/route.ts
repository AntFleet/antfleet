// POST /api/v1/installations — create a paywall installation row in
// pending_binding and return the binding challenge for the agent to sign.
//
// The agent then POSTs the signature to /api/v1/installations/{id}/bind.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { buildBindingChallenge } from "@/lib/paywall/challenge";
import { buildNextStep } from "@/lib/paywall/next-step";
import { insertPaywallInstallation, type PaywallInstallationRow } from "@/lib/paywall/queries";
import { PAYWALL_STATUS } from "@/lib/paywall/state";
import { db } from "@/db";
import { jsonError, jsonOk, NO_STORE, optionsResponse } from "@/lib/api-v1/responses";
import { logError, logInfo, logWarn } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  wallet_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "wallet_address must be 0x + 40 hex"),
});

export type CreateInstallationDeps = {
  insertInstallation: (args: { walletAddress: string }) => Promise<PaywallInstallationRow>;
};

const DEFAULT_DEPS: CreateInstallationDeps = {
  insertInstallation: (args) => insertPaywallInstallation(db, args),
};

export async function POST(req: NextRequest) {
  return handleCreateInstallation(req, DEFAULT_DEPS);
}

export function OPTIONS() {
  return optionsResponse();
}

export async function handleCreateInstallation(req: NextRequest, deps: CreateInstallationDeps) {
  try {
    const parsed = bodySchema.safeParse(await readJson(req));
    if (!parsed.success) {
      logWarn("paywall.create.rejected", { reason: "bad-request" });
      return jsonError(400, "invalid_input", parsed.error.issues[0]?.message ?? "bad request");
    }
    const walletAddress = parsed.data.wallet_address.toLowerCase();
    const row = await deps.insertInstallation({ walletAddress });
    // CRITICAL: use row.createdAt (set by Postgres `DEFAULT now()`) — NOT
    // deps.now(). The bind endpoint reconstructs the challenge from the
    // SAME row.createdAt later. Using deps.now() here desyncs the JS clock
    // from the Postgres clock; the agent signs message_T_js but the
    // server verifies against message_T_pg, producing a 401 signature
    // mismatch. Found in prod 2026-05-22 during the first real bind.
    const issuedAt = row.createdAt;
    const challenge = buildBindingChallenge({
      installationId: row.id,
      walletAddress,
      issuedAt,
    });
    logInfo("paywall.create.ok", { installationId: row.id, walletAddress });
    return jsonOk(
      {
        installation_id: row.id,
        status: PAYWALL_STATUS.pendingBinding,
        wallet_address: walletAddress,
        binding_challenge: challenge,
        binding_challenge_issued_at: issuedAt.toISOString(),
        next_step: buildNextStep({
          status: PAYWALL_STATUS.pendingBinding,
          installationId: row.id,
          challenge,
        }),
      },
      { cacheControl: NO_STORE },
    );
  } catch (err) {
    logError("paywall.create.internal", {
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
