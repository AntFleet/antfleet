import type { ReviewJobRow, X402SettlementStatus } from "@/lib/review-job-queries";

const X402_FAILURE_MESSAGES: Record<string, string> = {
  provider_error: "The review provider returned an error. The x402 payment was not settled.",
  timeout: "The review timed out. The x402 payment was not settled.",
  internal: "An internal error occurred. The x402 payment was not settled.",
  cost_cap_exceeded: "The review exceeded the inference cost cap. The x402 payment was not settled.",
  user_input: "The review could not proceed due to invalid input.",
  validation: "Validation failed for the requested review.",
};

export function x402FailureMessage(
  failureMode: string,
  settlementStatus: X402SettlementStatus,
): string {
  if (settlementStatus === "settled") {
    return "An internal error occurred after x402 payment settlement. The receipt is preserved.";
  }
  if (settlementStatus === "settlement_failed") {
    return "An internal error occurred while settling the x402 payment.";
  }
  return X402_FAILURE_MESSAGES[failureMode] ?? "An unexpected error occurred.";
}

export function x402FailureResultPayload(
  job: Pick<ReviewJobRow, "x402ReviewId">,
  settlementStatus: X402SettlementStatus,
): Record<string, unknown> {
  const reviewId = job.x402ReviewId;
  return {
    paid_via: "x402",
    settlement_status: settlementStatus,
    ...(reviewId !== null && reviewId !== undefined
      ? { reviewId, receipt_url: `/receipts/review/${reviewId}` }
      : {}),
  };
}
