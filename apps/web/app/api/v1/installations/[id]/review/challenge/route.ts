// POST /api/v1/installations/{id}/review/challenge — mint a single-use
// nonce for the on-demand review endpoint.
//
// Two-call flow vs /bind's stateless one-shot: bind is one-shot per install
// lifetime (created_at is a safe nonce); review is repeating, so we mint
// a fresh challenge_id per call and mark it used_at on redemption (see
// lib/paywall/review-challenge.ts and migration 0021).
//
// Auth on this endpoint: none. Anyone can request a challenge for any
// installation_id; only the wallet bound to the install can sign it,
// and the signature itself is the gate at the POST .../review step.
//
// Information hygiene: because this surface is unauthenticated, we
// deliberately collapse "row missing" / "wallet not yet claimed" /
// "wallet claimed but not bound" into a single 404 `not_eligible`
// response so an attacker probing installation UUIDs can't enumerate
// the lifecycle stage of a target install. The wallet address is also
// omitted from the success response — the legitimate caller already
// knows their own wallet (they're the one about to sign), and anyone
// else doesn't need to learn it from this endpoint.
//
// Idempotency: each call returns a fresh challenge_id even for the same
// install. The review_challenges row is the single-use token; collecting
// duplicate unredeemed challenges is harmless (expired cleanup is a
// future cron concern, see migration 0021's expiry index).

import type { NextRequest } from "next/server";
import { db } from "@/db";
import { jsonError, jsonOk, NO_STORE, optionsResponse } from "@/lib/api-v1/responses";
import { logError, logInfo, logWarn } from "@/lib/log";
import { buildReviewChallenge, REVIEW_CHALLENGE_MAX_AGE_MS } from "@/lib/paywall/review-challenge";
import {
  insertReviewChallenge,
  loadPaywallInstallation,
  type PaywallInstallationRow,
  type ReviewChallengeRow,
} from "@/lib/paywall/queries";
import { PAYWALL_STATUS } from "@/lib/paywall/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type IssueReviewChallengeDeps = {
  loadInstallation: (id: string) => Promise<PaywallInstallationRow | null>;
  insertChallenge: (args: {
    installationRowId: string;
    issuedAt: Date;
    expiresAt: Date;
  }) => Promise<ReviewChallengeRow>;
  now: () => Date;
};

const DEFAULT_DEPS: IssueReviewChallengeDeps = {
  loadInstallation: (id) => loadPaywallInstallation(db, id),
  insertChallenge: (args) => insertReviewChallenge(db, args),
  now: () => new Date(),
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleIssueReviewChallenge(req, ctx, DEFAULT_DEPS);
}

export function OPTIONS() {
  return optionsResponse();
}

export async function handleIssueReviewChallenge(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
  deps: IssueReviewChallengeDeps,
) {
  try {
    const { id } = await ctx.params;
    const row = await deps.loadInstallation(id);
    // Three distinct "not eligible" states all collapse into one external
    // response: row missing, no wallet claimed, or wallet claimed but
    // never bound. Log the precise reason internally so operators can
    // tell what failed, but never differentiate to the unauth caller.
    if (row === null) {
      logWarn("paywall.review_challenge.rejected", { reason: "not_found", id });
      return jsonError(404, "not_eligible", "installation is not eligible for review challenges");
    }
    if (row.walletAddress === null) {
      logWarn("paywall.review_challenge.rejected", { reason: "no_wallet", id });
      return jsonError(404, "not_eligible", "installation is not eligible for review challenges");
    }
    if (row.status !== PAYWALL_STATUS.active || row.walletBoundAt === null) {
      logWarn("paywall.review_challenge.rejected", {
        reason: row.walletBoundAt === null ? "wallet_not_bound" : "not_active",
        id,
      });
      return jsonError(404, "not_eligible", "installation is not eligible for review challenges");
    }
    const issuedAt = deps.now();
    const expiresAt = new Date(issuedAt.getTime() + REVIEW_CHALLENGE_MAX_AGE_MS);
    const inserted = await deps.insertChallenge({
      installationRowId: row.id,
      issuedAt,
      expiresAt,
    });
    const challenge = buildReviewChallenge({
      challengeId: inserted.id,
      installationRowId: row.id,
      walletAddress: row.walletAddress,
      issuedAt: inserted.issuedAt,
    });
    logInfo("paywall.review_challenge.issued", {
      installationId: row.id,
      challengeId: inserted.id,
    });
    // Response intentionally omits wallet_address — the legit caller is
    // the wallet's owner and already knows it. An anonymous probe should
    // get nothing about who's bound to this install row. The wallet is
    // still embedded in the `challenge` string (it has to be, to be
    // signable), which is acceptable: an attacker who gets the challenge
    // can read the wallet from it, but cannot do anything with it
    // (forging the signature requires the wallet's private key).
    return jsonOk(
      {
        challenge_id: inserted.id,
        challenge,
        installation_id: row.id,
        issued_at: inserted.issuedAt.toISOString(),
        expires_at: inserted.expiresAt.toISOString(),
      },
      { cacheControl: NO_STORE },
    );
  } catch (err) {
    logError("paywall.review_challenge.internal", {
      message: err instanceof Error ? err.message : String(err),
    });
    return jsonError(500, "internal", "internal error");
  }
}
