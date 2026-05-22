// POST /api/v1/installations/{id}/review — synchronous on-demand review.
//
// Pull-mode counterpart to the GitHub App's push-mode webhook. The
// webhook reviews automatically on PR open; Aeon agents (and other
// install-bound callers) hit this endpoint to trigger a review on a
// specific PR/SHA mid-session and get a two-model-consensus finding
// back inline.
//
// Surface contract (see docs/aeon-skill-pack.md for the long-form):
//   1. Caller GETs a challenge from POST .../review/challenge.
//   2. Caller signs the challenge string with the wallet bound to the
//      installation (EIP-191 personal_sign, same shape as /bind).
//   3. Caller POSTs here with { challenge_id, signature, pr_number? | sha?, repo? }.
//
// Both this endpoint and the webhook funnel channel debits through
// lib/paywall/gate.ts::debitForReview so the channel state mutation
// lives in one place. The webhook posts an invoice PR comment on
// insufficient balance; this endpoint returns 402 JSON. Same channel,
// same price, same finding schema.

import type { NextRequest } from "next/server";
import { Octokit } from "@octokit/rest";
import { recoverMessageAddress as viemRecoverMessageAddress } from "viem";
import { z } from "zod";
import { db } from "@/db";
import { enqueueReview, hashRepo, markReviewTerminallyFailed } from "@/db/queries";
import { jsonError, jsonOk, NO_STORE, optionsResponse } from "@/lib/api-v1/responses";
import { getInstallationToken } from "@/lib/github-app";
import { logError, logInfo, logWarn, messageOf } from "@/lib/log";
import { debitForReview, decideGate } from "@/lib/paywall/gate";
import { getReviewPriceUsdc } from "@/lib/paywall/env";
import {
  loadChannelBalanceForInstallation,
  loadPaywallInstallation,
  loadReviewChallenge,
  loadReviewForResponse,
  markReviewChallengeUsed,
  type PaywallInstallationRow,
  type ReviewChallengeRow,
  type ReviewResponsePayload,
} from "@/lib/paywall/queries";
import {
  buildReviewChallenge,
  REVIEW_CHALLENGE_FUTURE_SKEW_MS,
  REVIEW_CHALLENGE_MAX_AGE_MS,
} from "@/lib/paywall/review-challenge";
import { isBenchmarkRepo } from "@/lib/repo-benchmark";
import { isPublicRepo } from "@/lib/repo-visibility";
import { runReviewWorker } from "@/lib/review-worker";

// node:crypto is Node-only — lock this route off the Edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Same ceiling as the webhook — the review itself runs synchronously
// inside this request so the worker needs the full 300s window for its
// first attempt. Cron retry is the recovery surface on timeout.
export const maxDuration = 300;

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
  })
  .refine((v) => v.pr_number !== undefined || v.sha !== undefined, {
    message: "either pr_number or sha is required",
    path: ["pr_number"],
  });

type ParsedBody = z.infer<typeof bodySchema>;

// Structural duck-type for the Octokit surface this endpoint touches.
// Lets the test pass a minimal stub without instantiating the full
// @octokit/rest client. Methods mirror the production Octokit shape so
// the prod default just hands through `new Octokit({ auth })`.
export type ReviewOctokit = {
  rest: {
    pulls: {
      get: (params: { owner: string; repo: string; pull_number: number }) => Promise<{
        data: { head: { sha: string } };
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
  enqueueReview: typeof enqueueReview;
  debitForReview: typeof debitForReview;
  markChallengeUsed: (args: {
    challengeId: string;
    usedAt: Date;
    reviewId: string;
  }) => Promise<boolean>;
  markReviewTerminallyFailed: typeof markReviewTerminallyFailed;
  runReviewWorker: typeof runReviewWorker;
  loadReviewForResponse: (reviewId: string) => Promise<ReviewResponsePayload | null>;
  loadChannelBalance: (installationRowId: string) => Promise<string | null>;
  getInstallationToken: typeof getInstallationToken;
  makeOctokit: (token: string) => ReviewOctokit;
  isPublicRepo: (octokit: ReviewOctokit, owner: string, repo: string) => Promise<boolean>;
  isBenchmarkRepo: (octokit: ReviewOctokit, owner: string, repo: string) => Promise<boolean>;
  getPriceUsdc: () => string;
  now: () => Date;
};

const DEFAULT_DEPS: ReviewEndpointDeps = {
  loadInstallation: (id) => loadPaywallInstallation(db, id),
  loadChallenge: (id) => loadReviewChallenge(db, id),
  recoverMessageAddress: viemRecoverMessageAddress,
  decideGate,
  enqueueReview,
  debitForReview,
  markChallengeUsed: (args) => markReviewChallengeUsed(db, args),
  markReviewTerminallyFailed,
  runReviewWorker,
  loadReviewForResponse: (id) => loadReviewForResponse(db, id),
  loadChannelBalance: (id) => loadChannelBalanceForInstallation(db, id),
  getInstallationToken,
  makeOctokit: (token) => new Octokit({ auth: token }) as unknown as ReviewOctokit,
  isPublicRepo: (octokit, owner, repo) =>
    isPublicRepo(octokit as unknown as Parameters<typeof isPublicRepo>[0], owner, repo),
  isBenchmarkRepo: (octokit, owner, repo) =>
    isBenchmarkRepo(octokit as unknown as Parameters<typeof isBenchmarkRepo>[0], owner, repo),
  getPriceUsdc: getReviewPriceUsdc,
  now: () => new Date(),
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleReviewRequest(req, ctx, DEFAULT_DEPS);
}

export function OPTIONS() {
  return optionsResponse();
}

export async function handleReviewRequest(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
  deps: ReviewEndpointDeps,
) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    if (url.searchParams.get("force") === "true") {
      // v1 boundary — re-running a cached review would need either a
      // separate force_seq dimension on the (repo_hash, pr_number,
      // commit_sha) idempotency key or a delete-and-reinsert flow that
      // breaks finding_status FK history. Both are scope creep for the
      // Aeon partnership ship; idempotent caching by SHA already covers
      // the actual use case (Aeon asks for a review of a specific PR/SHA;
      // if the SHA hasn't moved the prior finding is still valid). When
      // demand justifies it we add a force surface in v2.
      return jsonError(
        501,
        "force_not_yet_supported",
        "force=true is not yet implemented; idempotency by (installation, sha) caches the prior finding",
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
    // Defensive: any old challenge that escaped the expires_at clamp.
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

    // Signature verified — now resolve the GitHub target. Auth context
    // (installationToken) comes first because we need an Octokit for both
    // PR resolution (sha → PR lookup) and visibility checks (publicReceipt,
    // isBenchmark) regardless of which input path the caller chose.
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
    // Identical to webhook's pre-enqueue gate read.
    const gate = await deps.decideGate(
      { installationId: install.installationId, repo: target.repo },
      // Default deps inside decideGate look up the gate row from db; we
      // don't override here so the prod surface uses the same query.
    );
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
    // gate.kind is "bypass" (legacy_partner) or "debit"

    // Mission 5 / 6 visibility flags. Same calls the webhook makes; the
    // helpers are fail-closed so a missing public-repo lookup defaults to
    // privateReceipt=false (safe). Per project memory, this endpoint also
    // honors the publicReceipt default-true rule for public repos.
    const [publicReceipt, isBenchmark] = await Promise.all([
      deps.isPublicRepo(octokit, target.owner, target.repo),
      deps.isBenchmarkRepo(octokit, target.owner, target.repo),
    ]);

    // Enqueue → returns reviewId. Idempotent on (repo_hash, pr_number,
    // commit_sha): isNew=false means a prior trigger (webhook or earlier
    // API call) already produced a review for this exact SHA.
    const repoHash = hashRepo(target.owner, target.repo);
    const enqueued = await deps.enqueueReview({
      repoHash,
      prNumber: target.prNumber,
      commitSha: target.sha,
      filesReviewed: [],
      promptVersion: "spike-v1",
      providerModelIds: {},
      providerResponses: { status: "pending" },
      agreementDecision: { status: "pending" },
      timingMs: 0,
      costEstimatedUsd: 0,
      schemaVersion: 1,
      installationId: install.installationId,
      owner: target.owner,
      repo: target.repo,
      publicReceipt,
      isBenchmark,
    });
    const { reviewId, isNew } = enqueued;

    // Atomic challenge redemption. The UPDATE's used_at IS NULL guard is
    // the anti-replay surface — two concurrent verifications for the same
    // challenge_id race here; the loser sees 0 rows. We terminally fail
    // the just-enqueued row (when isNew) so cron doesn't run a free review
    // off a lost-race redemption.
    const claimed = await deps.markChallengeUsed({
      challengeId: challenge.id,
      usedAt: now,
      reviewId,
    });
    if (!claimed) {
      if (isNew) {
        try {
          await deps.markReviewTerminallyFailed({
            reviewId,
            now: deps.now(),
            error: "challenge_lost_race",
          });
        } catch (err) {
          logError("review_endpoint.fail_after_lost_race", {
            id,
            reviewId,
            message: messageOf(err),
          });
        }
      }
      return jsonError(
        401,
        "challenge_already_used",
        "challenge_id was redeemed by another request",
      );
    }

    // Debit only on isNew=true. Per the brief, cached responses for a
    // prior (installation, sha) MUST NOT debit again — the prior call
    // already paid for the finding being returned.
    let debitedUsdc: string | null = null;
    let drawdownId: string | null = null;
    if (isNew) {
      if (gate.kind === "debit") {
        const debit = await deps.debitForReview(db, {
          decision: gate,
          reviewId,
          logContext: { id, surface: "api" },
        });
        if (!debit.ok) {
          // Race: balance dropped between the gate read and the atomic
          // debit (concurrent webhook on a different PR drained it). Mark
          // the row terminally failed — cron won't run a free review — and
          // surface 402 to the caller. Challenge is consumed but caller
          // can mint a fresh one once the channel is topped up.
          try {
            await deps.markReviewTerminallyFailed({
              reviewId,
              now: deps.now(),
              error: debit.reason,
            });
          } catch (err) {
            logError("review_endpoint.fail_after_debit_race", {
              id,
              reviewId,
              message: messageOf(err),
            });
          }
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
        debitedUsdc = debit.debitedUsdc;
        drawdownId = debit.drawdownId;
      }
      // bypass branch — legacy_partner installs never reach the new
      // endpoint in practice (they have no bound wallet), but the gate
      // can still return "bypass" if the operator manually flips the
      // flag on a wallet-bound row. No debit; proceed to worker.

      // Run the review synchronously. runReviewWorker handles its own
      // retry / terminal-fail accounting; on transient errors it returns
      // { kind: "retried", ... } and leaves the row in pending_retry for
      // the cron sweep to finish. On terminal errors, { kind: "failed" }
      // and we surface 502 to the caller.
      const outcome = await deps.runReviewWorker(reviewId, "api");
      logInfo("review_endpoint.worker_outcome", {
        id,
        reviewId,
        kind: outcome.kind,
      });
      if (outcome.kind === "failed") {
        return jsonError(502, "review_failed", outcome.error);
      }
      if (outcome.kind === "retried") {
        // Tell the caller the review is in flight; their next call with a
        // fresh challenge for the same SHA will return the cached finding.
        return jsonError(
          503,
          "review_in_progress",
          "review failed transiently and will be retried by the cron sweep",
        );
      }
      // outcome.kind === "done" | "skipped" (skipped only on
      // comment_already_posted re-settle, which means the row IS done)
    }

    const payload = await deps.loadReviewForResponse(reviewId);
    if (payload === null) {
      logError("review_endpoint.response_load_missing", { id, reviewId });
      return jsonError(500, "internal", "review row vanished after worker completion");
    }

    // bypass = legacy_partner installs have no channel; loadChannelBalance
    // returns null and the remaining_usdc field is omitted from the
    // response payload. For paid (debit) installs, the post-debit balance
    // is the source of truth — read it fresh rather than computing
    // gate.balanceUsdc - price (the gate balance was read before debit).
    const remainingUsdcLoaded = await deps.loadChannelBalance(install.id);
    const remainingUsdc = remainingUsdcLoaded ?? (gate.kind === "debit" ? gate.balanceUsdc : null);

    const agreed = extractAgreedFindings(payload.agreementDecision);
    return jsonOk(
      {
        cached: !isNew,
        receipt: {
          review_id: payload.reviewId,
          repo: { owner: target.owner, name: target.repo },
          pr_number: payload.prNumber,
          sha: payload.commitSha,
          finding_count: agreed.length,
          finding_ids: payload.findingIds,
          public_receipt: payload.publicReceipt,
          is_benchmark: payload.isBenchmark,
          pr_comment_url: payload.prCommentUrl,
        },
        findings: agreed,
        finding: agreed[0] ?? null,
        evidence: agreed.flatMap((f) =>
          Array.isArray(f.evidence)
            ? f.evidence.map((e) => ({ ...e, finding_title: f.title }))
            : [],
        ),
        channel: {
          debited_usdc: debitedUsdc,
          remaining_usdc: remainingUsdc,
          drawdown_id: drawdownId,
        },
      },
      { cacheControl: NO_STORE },
    );
  } catch (err) {
    logError("review_endpoint.internal", {
      message: err instanceof Error ? err.message : String(err),
    });
    return jsonError(500, "internal", "internal error");
  }
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

  // owner/repo resolution. The install row carries (owner, repo) for
  // single-repo installs; multi-repo installs carry one row per repo
  // (unique(installation_id, repo)), and the caller picks which one via
  // the URL's {id} — so install.owner/install.repo are unambiguous for
  // the chosen row. body.repo only matters if the caller wants to
  // override (e.g., the install row is missing owner/repo because the
  // GitHub App's first webhook hasn't landed yet).
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
      (install.owner !== owner || install.repo !== repo)
    ) {
      return {
        kind: "error",
        status: 400,
        code: "repo_install_mismatch",
        message: `installation is bound to ${install.owner}/${install.repo}; body.repo names ${owner}/${repo}`,
      };
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

  // PR/SHA resolution.
  if (body.pr_number !== undefined) {
    try {
      const pr = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: body.pr_number,
      });
      const sha = pr.data.head.sha;
      // If the caller supplied both pr_number and sha and they disagree,
      // they're asking about a stale PR head. Reject so we don't review
      // a non-existent target.
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

  // body.sha is set (the Zod refine guarantees pr_number XOR sha).
  if (body.sha === undefined) {
    // Defensive — the Zod refine should make this unreachable.
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
      // Unreachable after the length checks above; defensive.
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

type AgreedFinding = {
  title: string;
  severity: string;
  category: string;
  confidence?: string;
  evidence?: Array<{
    path: string;
    startLine: number | null;
    endLine: number | null;
    symbol: string | null;
    quote: string | null;
  }>;
  reasoning?: string;
  recommendation?: string;
  reproduction?: string | null;
  suggestedRegressionTest?: string | null;
  minimumFixScope?: string;
  whyTestsDoNotAlreadyCoverThis?: string;
};

function extractAgreedFindings(agreementDecision: unknown): AgreedFinding[] {
  if (typeof agreementDecision !== "object" || agreementDecision === null) return [];
  const d = agreementDecision as Record<string, unknown>;
  const agreed = d["agreed"];
  if (!Array.isArray(agreed)) return [];
  return agreed.filter((f): f is AgreedFinding => typeof f === "object" && f !== null);
}

async function readJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
