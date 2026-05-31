// POST /api/v1/installations/{id}/review — async on-demand review.
//
// Async-default contract (migration from sync). POST enqueues a review_jobs
// row, debits the channel, returns 202 + jobId immediately, then fires the
// worker via next/server after(). Caller polls GET .../review/{jobId} for
// the result.
//
// Surface contract:
//   1. Caller GETs a challenge from POST .../review/challenge.
//   2. Caller signs the challenge string with the wallet bound to the
//      installation (EIP-191 personal_sign, same shape as /bind).
//   3. Caller POSTs here with { challenge_id, signature, pr_number? | sha?, repo? }.
//   4. Response: 202 { jobId, statusUrl, expectedDurationSec }
//   5. Caller polls GET .../review/{jobId} until status != "queued" && != "running"
//
// Legacy sync callers that pass ?legacy=true get 410 Gone with migration doc.

import type { NextRequest } from "next/server";
import { after } from "next/server";
import { Octokit } from "@octokit/rest";
import { recoverMessageAddress as viemRecoverMessageAddress } from "viem";
import { z } from "zod";
import { db } from "@/db";
import { jsonError, NO_STORE, optionsResponse } from "@/lib/api-v1/responses";
import { getInstallationToken } from "@/lib/github-app";
import { logError, logInfo, logWarn, messageOf } from "@/lib/log";
import { debitForJob, decideGate } from "@/lib/paywall/gate";
import { getReviewPriceUsdc } from "@/lib/paywall/env";
import {
  claimReviewChallenge,
  linkReviewChallengeToReview,
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
import {
  createReviewJob,
  findJobByIdempotencyKey,
  linkDebitPaymentToJob,
  markBillingJobFailed,
  markJobQueued,
  type CreateReviewJobResult,
  type ReviewJobRow,
} from "@/lib/review-job-queries";
import { processReviewJob } from "@/lib/review-job-worker";
import { NextResponse } from "next/server";

// node:crypto is Node-only — lock this route off the Edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Shorter maxDuration since POST now returns 202 immediately. The worker
// runs in after() with its own timeout. Keep enough headroom for auth +
// debit + enqueue (all are fast DB ops).
export const maxDuration = 30;

const bodySchema = z
  .object({
    challenge_id: z.string().regex(/^[0-9a-f-]{36}$/, "challenge_id must be a uuid"),
    signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/, "signature must be 0x + 130 hex"),
    pr_number: z.number().int().positive().optional(),
    sha: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/i, "sha must be a hex commit identifier")
      .optional(),
    repo: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/, "repo must be owner/name")
      .optional(),
    idempotency_key: z.string().max(128).optional(),
  })
  .refine((v) => v.pr_number !== undefined || v.sha !== undefined, {
    message: "either pr_number or sha is required",
    path: ["pr_number"],
  });

type ParsedBody = z.infer<typeof bodySchema>;

export type ReviewOctokit = {
  rest: {
    pulls: {
      get: (params: { owner: string; repo: string; pull_number: number }) => Promise<{
        data: { state: string; head: { sha: string } };
      }>;
    };
    repos: {
      listPullRequestsAssociatedWithCommit: (params: {
        owner: string;
        repo: string;
        commit_sha: string;
      }) => Promise<{
        data: Array<{ number: number; state: string; head: { sha: string } }>;
      }>;
    };
  };
};

export type ReviewEndpointDeps = {
  loadInstallation: (id: string) => Promise<PaywallInstallationRow | null>;
  loadChallenge: (challengeId: string) => Promise<ReviewChallengeRow | null>;
  recoverMessageAddress: (args: { message: string; signature: `0x${string}` }) => Promise<string>;
  decideGate: typeof decideGate;
  debitForJob: typeof debitForJob;
  claimChallenge: (args: { challengeId: string; usedAt: Date }) => Promise<boolean>;
  linkChallengeToReview: (args: { challengeId: string; reviewId: string }) => Promise<void>;
  getInstallationToken: typeof getInstallationToken;
  makeOctokit: (token: string) => ReviewOctokit;
  getPriceUsdc: () => string;
  now: () => Date;
  createReviewJob: (args: Parameters<typeof createReviewJob>[1]) => Promise<CreateReviewJobResult>;
  findJobByIdempotencyKey: (
    installationId: string,
    idempotencyKey: string,
  ) => Promise<ReviewJobRow | null>;
  linkDebitToJob: (jobId: string, debitPaymentId: string) => Promise<void>;
  markBillingJobFailed: (
    jobId: string,
    failureMode: string,
    failureMessage: string,
    now: Date,
  ) => Promise<void>;
  markJobQueued: (jobId: string) => Promise<boolean>;
  scheduleWorker: (jobId: string) => void;
};

const DEFAULT_DEPS: ReviewEndpointDeps = {
  loadInstallation: (id) => loadPaywallInstallation(db, id),
  loadChallenge: (id) => loadReviewChallenge(db, id),
  recoverMessageAddress: viemRecoverMessageAddress,
  decideGate,
  debitForJob,
  claimChallenge: (args) => claimReviewChallenge(db, args),
  linkChallengeToReview: (args) => linkReviewChallengeToReview(db, args),
  getInstallationToken,
  makeOctokit: (token) => new Octokit({ auth: token }) as unknown as ReviewOctokit,
  getPriceUsdc: getReviewPriceUsdc,
  now: () => new Date(),
  createReviewJob: (args) => createReviewJob(db, args),
  findJobByIdempotencyKey: (installationId, idempotencyKey) =>
    findJobByIdempotencyKey(db, installationId, idempotencyKey),
  linkDebitToJob: (jobId, debitPaymentId) => linkDebitPaymentToJob(db, jobId, debitPaymentId),
  markBillingJobFailed: (jobId, failureMode, failureMessage, now) =>
    markBillingJobFailed(db, jobId, failureMode, failureMessage, now),
  markJobQueued: (jobId) => markJobQueued(db, jobId),
  scheduleWorker: (jobId) => {
    after(async () => {
      try {
        await processReviewJob(jobId);
      } catch (err) {
        logError("review_endpoint.after_worker_failed", {
          jobId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  },
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleReviewRequest(req, ctx, DEFAULT_DEPS);
}

export function OPTIONS() {
  return optionsResponse("POST, OPTIONS");
}

export async function handleReviewRequest(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
  deps: ReviewEndpointDeps,
) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);

    // 410 Gone for legacy sync callers
    if (url.searchParams.get("legacy") === "true") {
      return jsonError(
        410,
        "sync_mode_removed",
        "Synchronous /api/v1/installations/{id}/review was removed in the async-default contract. POST now returns 202 + jobId; poll GET /api/v1/installations/{id}/review/{jobId} for status. AntFleet/aeon-skills users: update to ≥v2.0.",
        {
          migrationDoc: "https://www.antfleet.dev/changelog",
        },
      );
    }

    if (url.searchParams.get("force") === "true") {
      return jsonError(
        501,
        "force_not_yet_supported",
        "force=true is not yet implemented; idempotency by (installation, idempotency_key) deduplicates",
      );
    }

    const parsed = bodySchema.safeParse(await readJson(req));
    if (!parsed.success) {
      logWarn("review_endpoint.rejected", { reason: "bad_request", id });
      return jsonError(400, "invalid_input", parsed.error.issues[0]?.message ?? "bad request");
    }
    const body = parsed.data;

    const install = await deps.loadInstallation(id);
    if (install === null) {
      return jsonError(404, "not_found", "installation not found");
    }
    if (install.walletAddress === null) {
      return jsonError(409, "missing_wallet", "installation has no bound wallet");
    }
    if (install.walletBoundAt === null) {
      return jsonError(409, "wallet_not_bound", "wallet has not completed binding");
    }
    if (install.installationId === null) {
      return jsonError(
        409,
        "github_app_not_installed",
        "GitHub App is not yet installed for this row; install antfleet[bot] first",
      );
    }

    // Validate challenge + signature (same EIP-191 flow as before)
    const challenge = await deps.loadChallenge(body.challenge_id);
    if (challenge === null) {
      return jsonError(401, "unknown_challenge", "challenge_id not found");
    }
    if (challenge.installationRowId !== install.id) {
      logWarn("review_endpoint.rejected", {
        reason: "challenge_install_mismatch",
        id,
        challengeInstall: challenge.installationRowId,
      });
      return jsonError(
        401,
        "challenge_install_mismatch",
        "challenge_id was issued for a different installation",
      );
    }
    if (challenge.usedAt !== null) {
      return jsonError(401, "challenge_already_used", "challenge_id has already been redeemed");
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
          signature: body.signature as `0x${string}`,
        })
      ).toLowerCase();
    } catch {
      return jsonError(400, "bad_signature", "could not recover address from signature");
    }
    if (recovered !== install.walletAddress) {
      logWarn("review_endpoint.rejected", {
        reason: "signature_mismatch",
        id,
        expected: install.walletAddress,
        recovered,
      });
      return jsonError(
        401,
        "signature_mismatch",
        "signature does not recover to the bound wallet_address",
      );
    }

    // Resolve target repo/PR
    let installationToken: string;
    try {
      installationToken = await deps.getInstallationToken(install.installationId);
    } catch (err) {
      logError("review_endpoint.install_token_failed", {
        id,
        installationId: install.installationId,
        message: messageOf(err),
      });
      return jsonError(502, "github_auth_failed", "could not authenticate as installation");
    }
    const octokit = deps.makeOctokit(installationToken);

    const target = await resolveTarget({ body, install, octokit });
    if (target.kind === "error") {
      return jsonError(target.status, target.code, target.message);
    }

    // Gate decision against the (github_installation_id, repo) channel.
    const gate = await deps.decideGate({
      installationId: install.installationId,
      repo: target.repo,
    });
    if (gate.kind === "not_installed") {
      return jsonError(
        409,
        "install_repo_mismatch",
        "installation does not cover the requested repo (or has not yet received its first webhook)",
      );
    }
    if (gate.kind === "insufficient") {
      return jsonError(
        402,
        "insufficient_channel_balance",
        "channel balance is below review price",
        {
          required_usdc: gate.priceUsdc,
          current_usdc: gate.balanceUsdc,
          wallet_address: gate.walletAddress,
        },
      );
    }

    // Idempotency check BEFORE challenge claim: if caller sent an
    // idempotency_key and a job exists, return it without consuming the
    // challenge. This lets callers retry with the same or a fresh
    // challenge and get the existing job back.
    if (body.idempotency_key) {
      const existing = await deps.findJobByIdempotencyKey(install.id, body.idempotency_key);
      if (existing !== null) {
        return reviewJobResponse(id, existing, 200);
      }
    }

    // Claim challenge atomically — AFTER idempotency check so a retry
    // with the same idempotency_key doesn't waste challenges.
    const claimed = await deps.claimChallenge({
      challengeId: challenge.id,
      usedAt: now,
    });
    if (!claimed) {
      return jsonError(
        401,
        "challenge_already_used",
        "challenge_id was redeemed by another request",
      );
    }

    // Create the job in a non-runnable billing state first. The safety-net
    // cron only picks up status='queued', so a racy or failed debit cannot
    // later run as an unpaid orphan.
    const createdJob = await deps.createReviewJob({
      installationId: install.id,
      walletAddress: install.walletAddress,
      repoOwner: target.owner,
      repoName: target.repo,
      prNumber: target.prNumber,
      sha: target.sha,
      idempotencyKey: body.idempotency_key ?? null,
      debitPaymentId: null,
      initialStatus: "billing_pending",
    });
    const job = createdJob.row;
    if (!createdJob.created) {
      logInfo("review_endpoint.idempotency_race_reused", {
        id,
        jobId: job.jobId,
        idempotencyKey: body.idempotency_key ?? null,
      });
      return reviewJobResponse(id, job, 200);
    }

    // Debit channel (only for gate.kind === "debit").
    // bypass (legacy partner): no debit — job proceeds with debitPaymentId=NULL.
    if (gate.kind === "debit") {
      const debit = await deps.debitForJob(db, {
        decision: gate,
        logContext: { id, surface: "api-async" },
      });
      if (!debit.ok) {
        await deps.markBillingJobFailed(
          job.jobId,
          "insufficient_channel_balance",
          "channel balance dropped below review price before debit",
          now,
        );
        return jsonError(
          402,
          "insufficient_channel_balance",
          "channel balance dropped below review price between gate read and debit",
          {
            required_usdc: gate.priceUsdc,
            current_usdc: gate.balanceUsdc,
            wallet_address: gate.walletAddress,
          },
        );
      }
      // Link the debit payment to the job row
      if (debit.drawdownId !== null) {
        await deps.linkDebitToJob(job.jobId, debit.drawdownId);
      }
    } else if (gate.kind === "bypass") {
      logInfo("review_endpoint.bypass_legacy_partner", { id, jobId: job.jobId });
    }

    const queued = await deps.markJobQueued(job.jobId);
    if (!queued) {
      throw new Error("review job left billing state before queue transition");
    }

    // Audit-link challenge to the job (best-effort)
    try {
      await deps.linkChallengeToReview({ challengeId: challenge.id, reviewId: job.jobId });
    } catch (err) {
      logError("review_endpoint.challenge_link_failed", {
        id,
        challengeId: challenge.id,
        jobId: job.jobId,
        message: messageOf(err),
      });
    }

    logInfo("review_job", {
      jobId: job.jobId,
      event: "enqueued",
      installationId: install.id,
    });

    // Fire worker in background
    deps.scheduleWorker(job.jobId);

    // Return 202 immediately
    return reviewJobResponse(id, job, 202);
  } catch (err) {
    logError("review_endpoint.internal", {
      message: err instanceof Error ? err.message : String(err),
    });
    return jsonError(500, "internal", "internal error");
  }
}

function reviewJobResponse(id: string, job: ReviewJobRow, status: 200 | 202): NextResponse {
  return NextResponse.json(
    {
      jobId: job.jobId,
      statusUrl: `/api/v1/installations/${id}/review/${job.jobId}`,
      status: job.status,
      expectedDurationSec: 180,
    },
    {
      status,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": NO_STORE,
        "Content-Type": "application/json; charset=utf-8",
      },
    },
  );
}

type ResolvedTarget =
  | {
      kind: "ok";
      owner: string;
      repo: string;
      prNumber: number;
      sha: string;
    }
  | { kind: "error"; status: number; code: string; message: string };

async function resolveTarget(args: {
  body: ParsedBody;
  install: PaywallInstallationRow;
  octokit: ReviewOctokit;
}): Promise<ResolvedTarget> {
  const { body, install, octokit } = args;

  let owner: string;
  let repo: string;
  if (body.repo !== undefined) {
    const [bo, br] = body.repo.split("/");
    if (bo === undefined || br === undefined) {
      return {
        kind: "error",
        status: 400,
        code: "invalid_repo",
        message: "repo must be owner/name",
      };
    }
    owner = bo;
    repo = br;
    if (
      install.owner !== null &&
      install.repo !== null &&
      (install.owner.toLowerCase() !== owner.toLowerCase() ||
        install.repo.toLowerCase() !== repo.toLowerCase())
    ) {
      return {
        kind: "error",
        status: 400,
        code: "repo_install_mismatch",
        message: `installation is bound to ${install.owner}/${install.repo}; body.repo names ${owner}/${repo}`,
      };
    }
    if (install.owner !== null && install.repo !== null) {
      owner = install.owner;
      repo = install.repo;
    }
  } else if (install.owner !== null && install.repo !== null) {
    owner = install.owner;
    repo = install.repo;
  } else {
    return {
      kind: "error",
      status: 400,
      code: "repo_required",
      message: "installation row has no bound repo; body.repo is required",
    };
  }

  if (body.pr_number !== undefined) {
    try {
      const pr = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: body.pr_number,
      });
      if (pr.data.state !== "open") {
        return {
          kind: "error",
          status: 400,
          code: "pr_not_open",
          message: `pr_number ${body.pr_number} is ${pr.data.state}; only open PRs can be reviewed`,
        };
      }
      const sha = pr.data.head.sha;
      if (body.sha !== undefined && body.sha.toLowerCase() !== sha.toLowerCase()) {
        return {
          kind: "error",
          status: 400,
          code: "sha_pr_mismatch",
          message: `pr_number ${body.pr_number} currently points at ${sha}; body.sha was ${body.sha}`,
        };
      }
      return { kind: "ok", owner, repo, prNumber: body.pr_number, sha };
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      if (status === 404) {
        return {
          kind: "error",
          status: 404,
          code: "pr_not_found",
          message: `pr_number ${body.pr_number} not found in ${owner}/${repo}`,
        };
      }
      return {
        kind: "error",
        status: 502,
        code: "github_lookup_failed",
        message: `could not fetch pr ${body.pr_number}: ${messageOf(err)}`,
      };
    }
  }

  if (body.sha === undefined) {
    return {
      kind: "error",
      status: 400,
      code: "target_required",
      message: "pr_number or sha is required",
    };
  }
  const shaLower = body.sha.toLowerCase();
  try {
    const associated = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      owner,
      repo,
      commit_sha: body.sha,
    });
    const openMatches = associated.data.filter(
      (pr) => pr.state === "open" && pr.head.sha.toLowerCase() === shaLower,
    );
    if (openMatches.length === 0) {
      return {
        kind: "error",
        status: 400,
        code: "sha_has_no_open_pr",
        message:
          "sha is not the head of any open PR in this repo; pass pr_number explicitly if known",
      };
    }
    if (openMatches.length > 1) {
      return {
        kind: "error",
        status: 400,
        code: "sha_matches_multiple_prs",
        message: `sha is the head of multiple open PRs (${openMatches.map((p) => p.number).join(", ")}); pass pr_number explicitly`,
      };
    }
    const pr = openMatches[0];
    if (pr === undefined) {
      return {
        kind: "error",
        status: 400,
        code: "sha_has_no_open_pr",
        message: "sha did not match any open PR after filter",
      };
    }
    return { kind: "ok", owner, repo, prNumber: pr.number, sha: pr.head.sha };
  } catch (err) {
    return {
      kind: "error",
      status: 502,
      code: "github_lookup_failed",
      message: `could not resolve sha ${body.sha}: ${messageOf(err)}`,
    };
  }
}

async function readJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
