import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { after, NextResponse } from "next/server";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { db } from "@/db";
import { jsonError, NO_STORE, optionsResponse } from "@/lib/api-v1/responses";
import { logError, logInfo, logWarn, messageOf } from "@/lib/log";
import {
  createX402ReviewJob,
  findX402JobByIdempotencyKey,
  type ReviewJobRow,
} from "@/lib/review-job-queries";
import { processReviewJob } from "@/lib/review-job-worker";
import { requireAeonContext } from "@/lib/x402/aeon-gate";
import {
  buildPaymentRequired,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  freeReviewCallerWallet,
  makeAuthorizationState,
  makeFreeAuthorizationState,
  PAYMENT_SIGNATURE_HEADER,
  verifyPayment,
  X402PaymentError,
  type VerifiedPayment,
} from "@/lib/x402/facilitator";
import {
  isFreeX402ReviewPrice,
  isX402ConfigError,
  loadX402Config,
  type X402Config,
} from "@/lib/x402/env";
import {
  checkWalletRateLimit,
  claimX402ReviewAuthorization,
  findRecentRepoShaJob,
  markX402ReviewClaimStatus,
  type X402ReviewClaimResult,
  type X402ReviewClaimStatus,
} from "@/lib/x402/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const X402_EXPOSE_HEADERS = `${PAYMENT_REQUIRED_HEADER}, ${PAYMENT_RESPONSE_HEADER}`;

const bodySchema = z
  .object({
    target: z
      .object({
        repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "repo must be owner/name"),
        pr: z.number().int().positive().optional(),
        sha: z
          .string()
          .regex(/^[0-9a-f]{7,64}$/i, "sha must be a hex commit identifier")
          .optional(),
      })
      .refine((v) => v.pr !== undefined || v.sha !== undefined, {
        message: "target.pr or target.sha is required",
        path: ["pr"],
      }),
    sting: z
      .object({
        run_id: z.string().optional(),
        correlation_id: z.string().optional(),
        idempotency_key: z.string().optional(),
        expected_review_price_usdc: z.number().optional(),
      })
      .optional(),
  })
  .strict();

type ParsedBody = z.infer<typeof bodySchema>;

type X402Octokit = {
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
      }) => Promise<{ data: Array<{ number: number; state: string; head: { sha: string } }> }>;
    };
  };
};

export type X402RouteDeps = {
  now: () => Date;
  loadConfig: () => X402Config;
  verifyPayment: typeof verifyPayment;
  createJob: (args: Parameters<typeof createX402ReviewJob>[1]) => Promise<ReviewJobRow>;
  findJobByIdempotencyKey: (idempotencyKey: string) => Promise<ReviewJobRow | null>;
  findRecentRepoShaJob: (args: {
    owner: string;
    repo: string;
    sha: string;
    callerWallet: string;
    now: Date;
  }) => Promise<ReviewJobRow | null>;
  checkWalletRateLimit: (args: {
    callerWallet: string;
    now: Date;
  }) => Promise<Awaited<ReturnType<typeof checkWalletRateLimit>>>;
  claimReviewAuthorization: (args: {
    authorizationKey: string;
    callerWallet: string;
    owner: string;
    repo: string;
    prNumber: number;
    sha: string;
    now: Date;
  }) => Promise<X402ReviewClaimResult>;
  markReviewClaimStatus: (args: {
    claimId: string;
    status: Exclude<X402ReviewClaimStatus, "claimed">;
    now: Date;
    jobId?: string | null;
    settlementResponse?: unknown;
  }) => Promise<void>;
  makeOctokit: () => X402Octokit;
  scheduleWorker: (jobId: string) => void;
};

const DEFAULT_DEPS: X402RouteDeps = {
  now: () => new Date(),
  loadConfig: () => loadX402Config(),
  verifyPayment,
  createJob: (args) => createX402ReviewJob(db, args),
  findJobByIdempotencyKey: (idempotencyKey) => findX402JobByIdempotencyKey(db, idempotencyKey),
  findRecentRepoShaJob: (args) => findRecentRepoShaJob(db, args),
  checkWalletRateLimit: (args) => checkWalletRateLimit(db, args),
  claimReviewAuthorization: (args) => claimX402ReviewAuthorization(db, args),
  markReviewClaimStatus: (args) => markX402ReviewClaimStatus(db, args),
  makeOctokit: () => {
    const token = process.env["GITHUB_PUBLIC_TOKEN"];
    return token ? new Octokit({ auth: token }) : new Octokit();
  },
  scheduleWorker: (jobId) => {
    after(async () => {
      try {
        await processReviewJob(jobId);
      } catch (err) {
        logError("x402_review_endpoint.after_worker_failed", {
          jobId,
          message: messageOf(err),
        });
      }
    });
  },
};

export async function POST(req: NextRequest) {
  return handleX402ReviewRequest(req, DEFAULT_DEPS);
}

export function OPTIONS() {
  return optionsResponse("POST, OPTIONS", "Content-Type, X-Aeon-Context, PAYMENT-SIGNATURE");
}

export async function handleX402ReviewRequest(req: NextRequest, deps: X402RouteDeps) {
  try {
    const now = deps.now();
    const gate = requireAeonContext(req, { now: deps.now, env: process.env });
    if (!gate.ok) return jsonError(403, gate.code, gate.message);

    let config: X402Config;
    try {
      config = deps.loadConfig();
    } catch (err) {
      if (isX402ConfigError(err) && err.code === "antfleet_x402_treasury_missing") {
        return jsonError(500, "treasury_unconfigured", "x402 treasury address not configured");
      }
      if (isX402ConfigError(err)) return jsonError(500, err.code, err.message);
      throw err;
    }

    const resource = new URL("/api/v1/review/x402", req.url).toString();
    const paymentSignature = req.headers.get(PAYMENT_SIGNATURE_HEADER);
    const freeReview = isFreeX402ReviewPrice(config);

    if (freeReview) {
      return enqueueFreeX402Review(req, deps, {
        config,
        resource,
        now,
        gate,
      });
    }

    if (paymentSignature === null || paymentSignature.trim() === "") {
      const paymentRequired = buildPaymentRequired(config, resource);
      return NextResponse.json(paymentRequired, {
        status: 402,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": X402_EXPOSE_HEADERS,
          "Cache-Control": NO_STORE,
          "Content-Type": "application/json; charset=utf-8",
          [PAYMENT_REQUIRED_HEADER]: Buffer.from(JSON.stringify(paymentRequired)).toString(
            "base64",
          ),
        },
      });
    }

    const parsed = bodySchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return jsonError(400, "invalid_input", parsed.error.issues[0]?.message ?? "bad request");
    }

    let payment: VerifiedPayment;
    try {
      payment = await deps.verifyPayment({
        paymentSignature: paymentSignature.trim(),
        config,
        resource,
        now,
      });
    } catch (err) {
      if (err instanceof X402PaymentError) {
        return jsonError(err.status, err.code, err.message);
      }
      throw err;
    }

    const target = await resolveTarget(parsed.data, deps.makeOctokit());
    if (target.kind === "error") return jsonError(target.status, target.code, target.message);

    const cooldownHit = await deps.findRecentRepoShaJob({
      owner: target.owner,
      repo: target.repo,
      sha: target.sha,
      callerWallet: payment.callerWallet,
      now,
    });
    if (cooldownHit !== null) return jobResponse(cooldownHit, statusForExisting(cooldownHit));

    const idempotencyKey = buildX402IdempotencyKey({
      callerWallet: payment.callerWallet,
      owner: target.owner,
      repo: target.repo,
      prNumber: target.prNumber,
      sha: target.sha,
    });
    const existing = await deps.findJobByIdempotencyKey(idempotencyKey);
    if (existing !== null) return jobResponse(existing, statusForExisting(existing));

    // Per-authorization replay guard (mirrors scan rail). The unique index on
    // authorization_key enforces single-use even if the Coinbase facilitator
    // does not. Placed AFTER cooldown + idempotency so legitimate retries on
    // the same PR short-circuit before consuming the claim; placed BEFORE
    // rate-limit + createJob so a stale authorization cannot drive two
    // distinct reviews.
    const claim = await deps.claimReviewAuthorization({
      authorizationKey: reviewAuthorizationKey(payment),
      callerWallet: payment.callerWallet,
      owner: target.owner,
      repo: target.repo,
      prNumber: target.prNumber,
      sha: target.sha,
      now,
    });
    if (!claim.claimed) {
      return jsonError(
        409,
        "duplicate_x402_authorization",
        "this x402 authorization has already been used for a review",
      );
    }

    const rate = await deps.checkWalletRateLimit({
      callerWallet: payment.callerWallet,
      now,
    });
    if (!rate.ok) {
      await deps.markReviewClaimStatus({
        claimId: claim.claimId,
        status: "rate_limited",
        now: deps.now(),
      });
      const res = jsonError(
        429,
        "rate_limited_wallet",
        `Rate limit exceeded: ${rate.limit} reviews per wallet per hour`,
        { retry_after_seconds: rate.retryAfterSeconds },
      );
      res.headers.set("Retry-After", String(rate.retryAfterSeconds));
      return res;
    }

    let job: ReviewJobRow;
    try {
      job = await deps.createJob({
        callerWallet: payment.callerWallet,
        repoOwner: target.owner,
        repoName: target.repo,
        prNumber: target.prNumber,
        sha: target.sha,
        idempotencyKey,
        x402PayTo: config.treasury,
        authorizationState: makeAuthorizationState(payment),
      });
    } catch (err) {
      await deps.markReviewClaimStatus({
        claimId: claim.claimId,
        status: "dispatch_failed",
        now: deps.now(),
      });
      throw err;
    }

    logInfo("x402_review_job", {
      jobId: job.jobId,
      event: "enqueued",
      repo: `${target.owner}/${target.repo}`,
      prNumber: target.prNumber,
      sha: target.sha,
      aeonSessionId: gate.ok && gate.required ? gate.sessionId : null,
    });

    deps.scheduleWorker(job.jobId);
    return jobResponse(job, 202);
  } catch (err) {
    logError("x402_review_endpoint.internal", {
      message: err instanceof Error ? err.message : String(err),
    });
    return jsonError(500, "internal", "internal error");
  }
}

type AeonGateOk = Extract<Awaited<ReturnType<typeof requireAeonContext>>, { ok: true }>;

async function enqueueFreeX402Review(
  req: NextRequest,
  deps: X402RouteDeps,
  args: {
    config: X402Config;
    resource: string;
    now: Date;
    gate: AeonGateOk;
  },
): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await readJson(req));
  if (!parsed.success) {
    return jsonError(400, "invalid_input", parsed.error.issues[0]?.message ?? "bad request");
  }

  const target = await resolveTarget(parsed.data, deps.makeOctokit());
  if (target.kind === "error") return jsonError(target.status, target.code, target.message);

  const callerWallet = freeReviewCallerWallet({
    sessionId: args.gate.required ? args.gate.sessionId : null,
    correlationId: parsed.data.sting?.correlation_id ?? null,
  });

  const cooldownHit = await deps.findRecentRepoShaJob({
    owner: target.owner,
    repo: target.repo,
    sha: target.sha,
    callerWallet,
    now: args.now,
  });
  if (cooldownHit !== null) return jobResponse(cooldownHit, statusForExisting(cooldownHit));

  const idempotencyKey = buildX402IdempotencyKey({
    callerWallet,
    owner: target.owner,
    repo: target.repo,
    prNumber: target.prNumber,
    sha: target.sha,
  });
  const existing = await deps.findJobByIdempotencyKey(idempotencyKey);
  if (existing !== null) return jobResponse(existing, statusForExisting(existing));

  const rate = await deps.checkWalletRateLimit({
    callerWallet,
    now: args.now,
  });
  if (!rate.ok) {
    const res = jsonError(
      429,
      "rate_limited_wallet",
      `Rate limit exceeded: ${rate.limit} reviews per wallet per hour`,
      { retry_after_seconds: rate.retryAfterSeconds },
    );
    res.headers.set("Retry-After", String(rate.retryAfterSeconds));
    return res;
  }

  let job: ReviewJobRow;
  try {
    job = await deps.createJob({
      callerWallet,
      repoOwner: target.owner,
      repoName: target.repo,
      prNumber: target.prNumber,
      sha: target.sha,
      idempotencyKey,
      x402PayTo: args.config.treasury,
      authorizationState: makeFreeAuthorizationState(args.resource, args.now),
      settlementStatus: "not_settled",
    });
  } catch (err) {
    throw err;
  }

  logInfo("x402_review_job", {
    jobId: job.jobId,
    event: "enqueued",
    repo: `${target.owner}/${target.repo}`,
    prNumber: target.prNumber,
    sha: target.sha,
    aeonSessionId: args.gate.required ? args.gate.sessionId : null,
    freeReview: true,
  });

  deps.scheduleWorker(job.jobId);
  return jobResponse(job, 202);
}

type ResolvedTarget =
  | { kind: "ok"; owner: string; repo: string; prNumber: number; sha: string }
  | { kind: "error"; status: number; code: string; message: string };

async function resolveTarget(body: ParsedBody, octokit: X402Octokit): Promise<ResolvedTarget> {
  const [owner, repo] = body.target.repo.split("/");
  if (owner === undefined || repo === undefined) {
    return { kind: "error", status: 400, code: "invalid_repo", message: "repo must be owner/name" };
  }

  if (body.target.pr !== undefined) {
    try {
      const pr = await octokit.rest.pulls.get({ owner, repo, pull_number: body.target.pr });
      if (pr.data.state !== "open") {
        return {
          kind: "error",
          status: 400,
          code: "pr_not_open",
          message: `PR #${body.target.pr} is ${pr.data.state}; only open PRs can be reviewed`,
        };
      }
      return { kind: "ok", owner, repo, prNumber: body.target.pr, sha: pr.data.head.sha };
    } catch (err) {
      return githubTargetError(err, "pr_not_found", "PR not found or repo is not accessible");
    }
  }

  const sha = body.target.sha!;
  try {
    const prs = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      owner,
      repo,
      commit_sha: sha,
    });
    const matches = prs.data.filter(
      (pr) => pr.state === "open" && pr.head.sha.toLowerCase() === sha.toLowerCase(),
    );
    if (matches.length === 0) {
      return {
        kind: "error",
        status: 400,
        code: "sha_not_in_open_pr",
        message: "sha does not match exactly one open PR head",
      };
    }
    if (matches.length > 1) {
      return {
        kind: "error",
        status: 400,
        code: "sha_ambiguous",
        message: "sha matches more than one open PR head",
      };
    }
    return { kind: "ok", owner, repo, prNumber: matches[0]!.number, sha: matches[0]!.head.sha };
  } catch (err) {
    return githubTargetError(err, "sha_not_in_open_pr", "sha not found or repo is not accessible");
  }
}

function githubTargetError(
  err: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): ResolvedTarget {
  const status = (err as { status?: number })?.status;
  if (status === 403 || status === 404) {
    return {
      kind: "error",
      status: 400,
      code: "repo_not_accessible",
      message: "repo is not publicly accessible",
    };
  }
  if (status !== undefined && status < 500) {
    return { kind: "error", status: 400, code: fallbackCode, message: fallbackMessage };
  }
  logWarn("x402_review_endpoint.github_target_resolution_failed", {
    status,
    message: messageOf(err),
  });
  return { kind: "error", status: 503, code: "github_unavailable", message: "GitHub unavailable" };
}

function reviewAuthorizationKey(payment: VerifiedPayment): string {
  return createHash("sha256").update(payment.payloadBase64).digest("hex");
}

export function buildX402IdempotencyKey(args: {
  callerWallet: string;
  owner: string;
  repo: string;
  prNumber: number;
  sha: string;
}): string {
  return createHash("sha256")
    .update(
      `${args.callerWallet.toLowerCase()}:${args.owner.toLowerCase()}/${args.repo.toLowerCase()}:${args.prNumber}:${args.sha.toLowerCase()}`,
    )
    .digest("hex");
}

function statusForExisting(job: ReviewJobRow): 200 | 202 {
  return job.status === "queued" || job.status === "running" ? 202 : 200;
}

function jobResponse(job: ReviewJobRow, status: 200 | 202): NextResponse {
  const key = job.idempotencyKey === null ? "" : `?key=${encodeURIComponent(job.idempotencyKey)}`;
  return NextResponse.json(
    {
      jobId: job.jobId,
      statusUrl: `/api/v1/review/x402/${job.jobId}${key}`,
      status: job.status,
      expectedDurationSec: 180,
    },
    {
      status,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": X402_EXPOSE_HEADERS,
        "Cache-Control": NO_STORE,
        "Content-Type": "application/json; charset=utf-8",
      },
    },
  );
}

async function readJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
