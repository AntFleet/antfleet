import type { NextRequest } from "next/server";
import { db } from "@/db";
import { jsonError, jsonOk, NO_STORE, optionsResponse } from "@/lib/api-v1/responses";
import { logError } from "@/lib/log";
import { getReviewJob, markX402JobExpired, type ReviewJobRow } from "@/lib/review-job-queries";
import { PAYMENT_RESPONSE_HEADER, paymentResponseHeader } from "@/lib/x402/facilitator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type X402PollDeps = {
  getReviewJob: (jobId: string) => Promise<ReviewJobRow | null>;
  markExpired: (jobId: string, now: Date) => Promise<ReviewJobRow | null>;
  now: () => Date;
};

const DEFAULT_DEPS: X402PollDeps = {
  getReviewJob: (jobId) => getReviewJob(db, jobId),
  markExpired: (jobId, now) => markX402JobExpired(db, jobId, now),
  now: () => new Date(),
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
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
    const loaded = await deps.getReviewJob(jobId);
    if (loaded === null || loaded.paymentRail !== "x402") {
      return jsonError(404, "not_found", "job not found");
    }
    const now = deps.now();
    const job = isExpiredInFlight(loaded, now)
      ? ((await deps.markExpired(jobId, now)) ?? loaded)
      : loaded;

    const body: Record<string, unknown> = {
      jobId: job.jobId,
      status: job.status,
      settlementStatus: job.x402SettlementStatus ?? "pending",
      retrievedAt: now.toISOString(),
    };
    if (job.status === "complete") {
      body.result = job.result;
    }
    if (job.status === "failed") {
      body.failureMode = job.failureMode;
      body.failureMessage = job.failureMessage;
      body.result = job.result;
    }
    const res = jsonOk(body, { cacheControl: NO_STORE });
    if (job.status === "complete" && job.x402SettlementStatus === "settled") {
      if (job.x402SettlementResponse !== null && job.x402SettlementResponse !== undefined) {
        const settlementResponse = paymentResponseHeader(job.x402SettlementResponse);
        res.headers.set(PAYMENT_RESPONSE_HEADER, settlementResponse);
        res.headers.set("Access-Control-Expose-Headers", PAYMENT_RESPONSE_HEADER);
      }
    }
    return res;
  } catch (err) {
    logError("x402_review_poll_endpoint.internal", {
      message: err instanceof Error ? err.message : String(err),
    });
    return jsonError(500, "internal", "internal error");
  }
}

function isExpiredInFlight(job: ReviewJobRow, now: Date): boolean {
  return (
    (job.status === "queued" || job.status === "running") &&
    job.x402ValidBefore !== null &&
    job.x402ValidBefore !== undefined &&
    job.x402ValidBefore.getTime() <= now.getTime()
  );
}
