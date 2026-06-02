import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { Octokit } from "@octokit/rest";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "@/db";
import { jsonError, NO_STORE, optionsResponse } from "@/lib/api-v1/responses";
import { logError, logInfo, logWarn, messageOf } from "@/lib/log";
import { requireAeonContextForScan } from "@/lib/x402/aeon-gate";
import {
  buildScanPaymentRequired,
  makeAuthorizationState,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  settlePayment,
  verifyPayment,
  X402PaymentError,
  type VerifiedPayment,
} from "@/lib/x402/facilitator";
import { isX402ConfigError, loadX402Config, type X402Config } from "@/lib/x402/env";
import {
  checkWalletRateLimit,
  claimX402ScanAuthorization,
  markX402ScanClaimStatus,
  type WalletRateLimitResult,
  type X402ScanClaimResult,
  type X402ScanClaimStatus,
} from "@/lib/x402/rate-limit";
import { scanRepo, type ScanOctokit, type ScanResult } from "@/lib/repo-scanner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 5 minutes — covers up to 10 parallel chunk reviews. Vercel hard-kills at this
// boundary; see the settlement note in handleX402ScanRequest.
export const maxDuration = 300;

const X402_EXPOSE_HEADERS = `${PAYMENT_REQUIRED_HEADER}, ${PAYMENT_RESPONSE_HEADER}`;

const bodySchema = z
  .object({
    target: z
      .object({
        repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "repo must be owner/name"),
      })
      .strict(),
  })
  .strict();

type ParsedBody = z.infer<typeof bodySchema>;

// Structural Octokit surface the route needs: repos.get (with `private`) for the
// accessibility check, plus everything scanRepo touches (so the same client is
// handed straight through). A superset of ScanOctokit, hence assignable to it.
type ScanRouteOctokit = {
  rest: {
    repos: {
      get: (params: { owner: string; repo: string }) => Promise<{
        data: { private: boolean; default_branch: string };
      }>;
      getContent: ScanOctokit["rest"]["repos"]["getContent"];
    };
    git: ScanOctokit["rest"]["git"];
  };
};

export type X402ScanRouteDeps = {
  now: () => Date;
  loadConfig: () => X402Config;
  verifyPayment: typeof verifyPayment;
  settlePayment: typeof settlePayment;
  checkWalletRateLimit: (args: {
    callerWallet: string;
    now: Date;
    includeCurrent?: boolean;
  }) => Promise<WalletRateLimitResult>;
  claimScanAuthorization: (args: {
    authorizationKey: string;
    callerWallet: string;
    owner: string;
    repo: string;
    now: Date;
  }) => Promise<X402ScanClaimResult>;
  markScanClaimStatus: (args: {
    claimId: string;
    status: Exclude<X402ScanClaimStatus, "claimed">;
    now: Date;
    headSha?: string | null;
    settlementResponse?: unknown;
  }) => Promise<void>;
  makeOctokit: () => ScanRouteOctokit;
  scanRepo: typeof scanRepo;
};

const DEFAULT_DEPS: X402ScanRouteDeps = {
  now: () => new Date(),
  loadConfig: () => loadX402Config(),
  verifyPayment,
  settlePayment,
  checkWalletRateLimit: (args) => checkWalletRateLimit(db, args),
  claimScanAuthorization: (args) => claimX402ScanAuthorization(db, args),
  markScanClaimStatus: (args) => markX402ScanClaimStatus(db, args),
  makeOctokit: () => {
    const token = process.env["GITHUB_PUBLIC_TOKEN"];
    return (token ? new Octokit({ auth: token }) : new Octokit()) as unknown as ScanRouteOctokit;
  },
  scanRepo,
};

export async function POST(req: NextRequest) {
  return handleX402ScanRequest(req, DEFAULT_DEPS);
}

export function OPTIONS() {
  return optionsResponse("POST, OPTIONS", "Content-Type, X-Aeon-Context, PAYMENT-SIGNATURE");
}

export async function handleX402ScanRequest(req: NextRequest, deps: X402ScanRouteDeps) {
  try {
    const now = deps.now();
    // Scan endpoint is public by default (gate only enforced when
    // X402_REQUIRE_AEON_CONTEXT === "true"). This does NOT affect the PR-review
    // gate, which stays gated-by-default.
    const gate = requireAeonContextForScan(req, { now: deps.now, env: process.env });
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

    const resource = new URL("/api/v1/scan/x402", req.url).toString();
    const scanRequirements = buildScanPaymentRequired(config, resource);
    const paymentRequirements = scanRequirements.accepts[0];

    const paymentSignature = req.headers.get(PAYMENT_SIGNATURE_HEADER);
    if (paymentSignature === null || paymentSignature.trim() === "") {
      return NextResponse.json(scanRequirements, {
        status: 402,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": X402_EXPOSE_HEADERS,
          "Cache-Control": NO_STORE,
          "Content-Type": "application/json; charset=utf-8",
          [PAYMENT_REQUIRED_HEADER]: Buffer.from(JSON.stringify(scanRequirements)).toString(
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
        paymentRequirements,
      });
    } catch (err) {
      if (err instanceof X402PaymentError) return jsonError(err.status, err.code, err.message);
      throw err;
    }

    const octokit = deps.makeOctokit();
    const target = await resolveScanTarget(parsed.data, octokit);
    if (target.kind === "error") return jsonError(target.status, target.code, target.message);

    const claim = await deps.claimScanAuthorization({
      authorizationKey: scanAuthorizationKey(payment),
      callerWallet: payment.callerWallet,
      owner: target.owner,
      repo: target.repo,
      now,
    });
    if (!claim.claimed) {
      return jsonError(
        409,
        "duplicate_x402_authorization",
        "this x402 authorization has already been used for a scan",
      );
    }

    const rate = await deps.checkWalletRateLimit({
      callerWallet: payment.callerWallet,
      now,
      includeCurrent: true,
    });
    if (!rate.ok) {
      await deps.markScanClaimStatus({
        claimId: claim.claimId,
        status: "rate_limited",
        now: deps.now(),
      });
      const res = jsonError(
        429,
        "rate_limited_wallet",
        `Rate limit exceeded: ${rate.limit} requests per wallet per hour`,
        { retry_after_seconds: rate.retryAfterSeconds },
      );
      res.headers.set("Retry-After", String(rate.retryAfterSeconds));
      return res;
    }

    // Run the scan BEFORE settling. If scanRepo throws (provider error, timeout,
    // or a Vercel hard-kill at maxDuration) the response never sends and
    // settlePayment is never called — the buyer pays nothing for a failed or
    // timed-out scan. This is the intended v1 behaviour: verify-then-work, settle
    // only after the work actually ran.
    let result: ScanResult;
    try {
      result = await deps.scanRepo({
        owner: target.owner,
        repo: target.repo,
        octokit,
        signal: req.signal,
      });
    } catch (err) {
      logError("x402_scan_endpoint.scan_failed", {
        repo: `${target.owner}/${target.repo}`,
        message: messageOf(err),
      });
      await deps.markScanClaimStatus({
        claimId: claim.claimId,
        status: "scan_failed",
        now: deps.now(),
      });
      // No settlement on the provider-error path (mirrors PR review).
      return jsonError(502, "scan_failed", "repo scan failed");
    }

    // A repo with no reviewable files produces zero chunks — reviewPR was never
    // called and no provider work was done. Don't settle: charging the flat
    // scan price for literally no work would be pure rent. (A scan that DID run
    // chunks but reached no consensus still settles below, with degraded:true —
    // that work cost real model spend, mirroring the PR-review path.)
    if (result.chunkCount === 0) {
      await deps.markScanClaimStatus({
        claimId: claim.claimId,
        status: "no_reviewable_files",
        now: deps.now(),
        headSha: result.headSha,
      });
      return jsonError(422, "no_reviewable_files", "repo has no reviewable files to scan");
    }

    let settlementResponse: unknown = null;
    try {
      const settlement = await deps.settlePayment({
        job: { x402PayTo: config.treasury },
        config,
        authorization: makeAuthorizationState(payment),
        now: deps.now(),
        paymentRequirements,
      });
      settlementResponse = settlement.response;
    } catch (err) {
      // The scan completed but settlement failed. Don't hand back findings the
      // buyer hasn't paid for; surface the settlement error so they can retry.
      logWarn("x402_scan_endpoint.settle_failed", {
        repo: `${target.owner}/${target.repo}`,
        message: messageOf(err),
      });
      await deps.markScanClaimStatus({
        claimId: claim.claimId,
        status: "settlement_failed",
        now: deps.now(),
        headSha: result.headSha,
        settlementResponse:
          err instanceof X402PaymentError ? { code: err.code, message: err.message } : null,
      });
      if (err instanceof X402PaymentError) return jsonError(err.status, err.code, err.message);
      return jsonError(502, "x402_settle_failed", "x402 settlement failed");
    }

    await deps.markScanClaimStatus({
      claimId: claim.claimId,
      status: "settled",
      now: deps.now(),
      headSha: result.headSha,
      settlementResponse,
    });

    logInfo("x402_scan", {
      event: "complete",
      repo: `${target.owner}/${target.repo}`,
      headSha: result.headSha,
      chunkCount: result.chunkCount,
      totalFiles: result.totalFiles,
      agreedCount: result.findings.length,
      degraded: result.degraded,
      aeonSessionId: gate.ok && gate.required ? gate.sessionId : null,
    });

    return NextResponse.json(
      {
        status: "complete",
        repo: `${target.owner}/${target.repo}`,
        headSha: result.headSha,
        chunkCount: result.chunkCount,
        totalFiles: result.totalFiles,
        agreedCount: result.findings.length,
        findings: result.findings,
        costUsdc: config.repoScanPriceUsdc,
      },
      {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": X402_EXPOSE_HEADERS,
          "Cache-Control": NO_STORE,
          "Content-Type": "application/json; charset=utf-8",
        },
      },
    );
  } catch (err) {
    logError("x402_scan_endpoint.internal", { message: messageOf(err) });
    return jsonError(500, "internal", "internal error");
  }
}

function scanAuthorizationKey(payment: VerifiedPayment): string {
  return createHash("sha256").update(payment.payloadBase64).digest("hex");
}

type ResolvedScanTarget =
  | { kind: "ok"; owner: string; repo: string }
  | { kind: "error"; status: number; code: string; message: string };

async function resolveScanTarget(
  body: ParsedBody,
  octokit: ScanRouteOctokit,
): Promise<ResolvedScanTarget> {
  const [owner, repo] = body.target.repo.split("/");
  if (owner === undefined || repo === undefined) {
    return { kind: "error", status: 400, code: "invalid_repo", message: "repo must be owner/name" };
  }
  try {
    const info = await octokit.rest.repos.get({ owner, repo });
    if (info.data.private) {
      return {
        kind: "error",
        status: 400,
        code: "private_repo_not_supported",
        message: "v1 supports public repositories only",
      };
    }
    return { kind: "ok", owner, repo };
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 403 || status === 404) {
      return {
        kind: "error",
        status: 400,
        code: "repo_not_accessible",
        message: "repo is not publicly accessible",
      };
    }
    logWarn("x402_scan_endpoint.repo_resolution_failed", { status, message: messageOf(err) });
    return {
      kind: "error",
      status: 503,
      code: "github_unavailable",
      message: "GitHub unavailable",
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
