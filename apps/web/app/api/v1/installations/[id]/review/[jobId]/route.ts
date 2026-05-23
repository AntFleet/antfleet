// GET /api/v1/installations/{id}/review/{jobId} — poll for async review status.
//
// Wallet-binding auth: the caller must be the same wallet that created the job.
// Returns 404 on both "job not found" and "wallet mismatch" to prevent
// enumeration via timing or response differentiation.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { jsonError, jsonOk, NO_STORE, optionsResponse } from "@/lib/api-v1/responses";
import { logError } from "@/lib/log";
import { getReviewJob, type ReviewJobRow } from "@/lib/review-job-queries";
import {
  loadPaywallInstallation,
  loadReviewChallenge,
  type PaywallInstallationRow,
  type ReviewChallengeRow,
} from "@/lib/paywall/queries";
import {
  buildReviewChallenge,
  REVIEW_CHALLENGE_FUTURE_SKEW_MS,
  REVIEW_CHALLENGE_MAX_AGE_MS,
} from "@/lib/paywall/review-challenge";
import { recoverMessageAddress as viemRecoverMessageAddress } from "viem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  challenge_id: z.string().regex(/^[0-9a-f-]{36}$/, "challenge_id must be a uuid"),
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/, "signature must be 0x + 130 hex"),
});

export type PollEndpointDeps = {
  loadInstallation: (id: string) => Promise<PaywallInstallationRow | null>;
  loadChallenge: (challengeId: string) => Promise<ReviewChallengeRow | null>;
  recoverMessageAddress: (args: { message: string; signature: `0x${string}` }) => Promise<string>;
  getReviewJob: (jobId: string) => Promise<ReviewJobRow | null>;
  now: () => Date;
};

const DEFAULT_DEPS: PollEndpointDeps = {
  loadInstallation: (id) => loadPaywallInstallation(db, id),
  loadChallenge: (id) => loadReviewChallenge(db, id),
  recoverMessageAddress: viemRecoverMessageAddress,
  getReviewJob: (jobId) => getReviewJob(db, jobId),
  now: () => new Date(),
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; jobId: string }> },
) {
  return handlePollRequest(req, ctx, DEFAULT_DEPS);
}

export function OPTIONS() {
  return optionsResponse();
}

export async function handlePollRequest(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; jobId: string }> },
  deps: PollEndpointDeps,
) {
  try {
    const { id, jobId } = await ctx.params;
    const url = new URL(req.url);
    const challengeId = url.searchParams.get("challenge_id");
    const signature = url.searchParams.get("signature");

    const parsed = querySchema.safeParse({ challenge_id: challengeId, signature });
    if (!parsed.success) {
      return jsonError(400, "invalid_input", parsed.error.issues[0]?.message ?? "bad request");
    }

    // Authenticate: same EIP-191 flow as POST, but via query params for GET
    const install = await deps.loadInstallation(id);
    if (install === null || install.walletAddress === null) {
      return jsonError(404, "not_found", "job not found");
    }

    const challenge = await deps.loadChallenge(parsed.data.challenge_id);
    if (challenge === null || challenge.installationRowId !== install.id) {
      return jsonError(404, "not_found", "job not found");
    }

    const now = deps.now();
    const skewMs = challenge.issuedAt.getTime() - now.getTime();
    if (skewMs > REVIEW_CHALLENGE_FUTURE_SKEW_MS) {
      return jsonError(401, "stale_challenge", "challenge is from the future");
    }
    if (now.getTime() > challenge.expiresAt.getTime()) {
      return jsonError(401, "expired_challenge", "challenge has expired; mint a fresh one");
    }
    if (-skewMs > REVIEW_CHALLENGE_MAX_AGE_MS) {
      return jsonError(401, "expired_challenge", "challenge has expired; mint a fresh one");
    }

    const message = buildReviewChallenge({
      challengeId: challenge.id,
      installationRowId: install.id,
      walletAddress: install.walletAddress,
      issuedAt: challenge.issuedAt,
    });

    let recovered: string;
    try {
      recovered = (
        await deps.recoverMessageAddress({
          message,
          signature: parsed.data.signature as `0x${string}`,
        })
      ).toLowerCase();
    } catch {
      return jsonError(400, "bad_signature", "could not recover address from signature");
    }
    if (recovered !== install.walletAddress) {
      return jsonError(404, "not_found", "job not found");
    }

    // Auth passed — fetch the job
    const job = await deps.getReviewJob(jobId);

    // 404 on both not-found and wallet-mismatch (prevents enumeration)
    if (job === null || job.walletAddress !== install.walletAddress) {
      return jsonError(404, "not_found", "job not found");
    }

    // Verify job belongs to the requested installation
    if (job.installationId !== id) {
      return jsonError(404, "not_found", "job not found");
    }

    const response: Record<string, unknown> = {
      status: job.status,
      retrievedAt: now.toISOString(),
    };

    if (job.status === "complete" && job.result !== null) {
      response.result = job.result;
    }

    if (job.status === "failed") {
      response.failureMode = job.failureMode;
      response.failureMessage = job.failureMessage;
    }

    return jsonOk(response, { cacheControl: NO_STORE });
  } catch (err) {
    logError("review_poll_endpoint.internal", {
      message: err instanceof Error ? err.message : String(err),
    });
    return jsonError(500, "internal", "internal error");
  }
}
