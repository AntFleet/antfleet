import type { NextRequest } from "next/server";
import { db } from "@/db";
import { jsonError, jsonOk, NO_STORE, optionsResponse } from "@/lib/api-v1/responses";
import { logError } from "@/lib/log";
import { getReviewJob, type ReviewJobRow } from "@/lib/review-job-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type AcpJobStatusDeps = {
  getReviewJob: (jobId: string) => Promise<ReviewJobRow | null>;
  now: () => Date;
};

const DEFAULT_DEPS: AcpJobStatusDeps = {
  getReviewJob: (jobId) => getReviewJob(db, jobId),
  now: () => new Date(),
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  return handleAcpJobStatusRequest(req, ctx, DEFAULT_DEPS);
}

export function OPTIONS() {
  return optionsResponse("GET, OPTIONS");
}

export async function handleAcpJobStatusRequest(
  _req: NextRequest,
  ctx: { params: Promise<{ jobId: string }> },
  deps: AcpJobStatusDeps,
) {
  try {
    const { jobId } = await ctx.params;
    const job = await deps.getReviewJob(jobId);
    if (job === null || job.paymentRail !== "acp") {
      return jsonError(404, "not_found", "job not found");
    }

    const body: Record<string, unknown> = {
      jobId: job.jobId,
      status: job.status,
      submitStatus: job.acpSubmitStatus ?? "pending",
      retrievedAt: deps.now().toISOString(),
    };
    if (job.status === "complete") {
      body.result = publicAcpResultSummary(job.result);
    }
    if (job.status === "failed") {
      body.failureMode = job.failureMode;
      body.failureMessage = job.failureMessage;
      body.result = publicAcpResultSummary(job.result);
    }
    return jsonOk(body, { cacheControl: NO_STORE });
  } catch (err) {
    logError("acp_review_job_status.internal", {
      message: err instanceof Error ? err.message : String(err),
    });
    return jsonError(500, "internal", "internal error");
  }
}

function publicAcpResultSummary(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const review =
    typeof record["review"] === "object" && record["review"] !== null
      ? (record["review"] as Record<string, unknown>)
      : null;
  const job =
    typeof record["job"] === "object" && record["job"] !== null
      ? (record["job"] as Record<string, unknown>)
      : null;
  const receipt =
    typeof record["receipt"] === "object" && record["receipt"] !== null
      ? (record["receipt"] as Record<string, unknown>)
      : null;
  const findings = Array.isArray(record["findings"]) ? record["findings"] : null;
  return {
    schema_version: record["schema_version"],
    status: record["status"],
    review_id: review?.["review_id"],
    review_receipt_url: receipt?.["review_receipt_url"] ?? record["review_receipt_url"],
    status_url: job?.["status_url"],
    findings_count: findings?.length,
    error: publicAcpErrorSummary(record["error"]),
  };
}

function publicAcpErrorSummary(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const details =
    typeof record["details"] === "object" && record["details"] !== null
      ? (record["details"] as Record<string, unknown>)
      : null;
  return {
    code: record["code"],
    message: record["message"],
    retryable: record["retryable"],
    settlement: record["settlement"],
    details: details === null ? null : { antfleet_job_id: details["antfleet_job_id"] },
  };
}
