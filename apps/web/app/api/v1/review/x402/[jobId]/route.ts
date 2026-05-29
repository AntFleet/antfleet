import type { NextRequest } from "next/server";
import { db } from "@/db";
import { jsonError, jsonOk, NO_STORE, optionsResponse } from "@/lib/api-v1/responses";
import { logError } from "@/lib/log";
import { getReviewJob, type ReviewJobRow } from "@/lib/review-job-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type X402PollDeps = {
  getReviewJob: (jobId: string) => Promise<ReviewJobRow | null>;
  now: () => Date;
};

const DEFAULT_DEPS: X402PollDeps = {
  getReviewJob: (jobId) => getReviewJob(db, jobId),
  now: () => new Date(),
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ jobId: string }> },
) {
  void req;
  return handleX402PollRequest(ctx, DEFAULT_DEPS);
}

export function OPTIONS() {
  return optionsResponse("GET, OPTIONS");
}

export async function handleX402PollRequest(
  ctx: { params: Promise<{ jobId: string }> },
  deps: X402PollDeps,
) {
  try {
    const { jobId } = await ctx.params;
    const job = await deps.getReviewJob(jobId);
    if (job === null || job.paymentRail !== "x402") {
      return jsonError(404, "not_found", "job not found");
    }

    const body: Record<string, unknown> = {
      jobId: job.jobId,
      status: job.status,
      settlementStatus: job.x402SettlementStatus ?? "pending",
      retrievedAt: deps.now().toISOString(),
    };
    if (job.status === "complete") {
      body.result = job.result;
    }
    if (job.status === "failed") {
      body.failureMode = job.failureMode;
      body.failureMessage = job.failureMessage;
      body.result = job.result;
    }
    return jsonOk(body, { cacheControl: NO_STORE });
  } catch (err) {
    logError("x402_review_poll_endpoint.internal", {
      message: err instanceof Error ? err.message : String(err),
    });
    return jsonError(500, "internal", "internal error");
  }
}
