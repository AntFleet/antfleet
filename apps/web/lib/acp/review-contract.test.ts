import { describe, expect, it } from "vitest";
import deliverableSchemaJson from "@/public/schemas/acp/review-deliverable-v0.json";
import errorSchemaJson from "@/public/schemas/acp/review-error-v0.json";
import requestSchemaJson from "@/public/schemas/acp/review-request-v0.json";
import deliverableWithFindingsFixture from "@/data/acp/review-deliverable.findings.json";
import noFindingsDeliverableFixture from "@/data/acp/review-deliverable.no-findings.json";
import degradedErrorFixture from "@/data/acp/review-error.provider-degraded.json";
import validRequestFixture from "@/data/acp/review-request.valid-pr.json";
import type { Finding } from "@/lib/review-types";
import {
  ACP_REVIEW_DELIVERABLE_SCHEMA_ID,
  ACP_REVIEW_DELIVERABLE_SCHEMA_VERSION,
  ACP_REVIEW_ERROR_SCHEMA_ID,
  ACP_REVIEW_ERROR_SCHEMA_VERSION,
  ACP_REVIEW_REQUEST_SCHEMA_ID,
  ACP_TRADING_DISCLAIMER,
  acpRepoCooldownKey,
  acpReviewDeliverableSchema,
  acpReviewErrorSchema,
  acpReviewFindingSchema,
  acpReviewRequestSchema,
  acpWalletRateLimitKey,
  buildAcpReviewDeliverable,
  buildAcpReviewError,
  mapFindingToAcpFinding,
  parseAcpReviewRequest,
  validateTradingAcknowledgment,
} from "./review-contract";

describe("ACP review contract schemas", () => {
  it("publishes the spec schema IDs from public static files", () => {
    expect(requestSchemaJson.$id).toBe(ACP_REVIEW_REQUEST_SCHEMA_ID);
    expect(deliverableSchemaJson.$id).toBe(ACP_REVIEW_DELIVERABLE_SCHEMA_ID);
    expect(errorSchemaJson.$id).toBe(ACP_REVIEW_ERROR_SCHEMA_ID);
  });

  it("accepts fixture request, deliverable, no-finding deliverable, and error payloads", () => {
    expect(() => acpReviewRequestSchema.parse(validRequestFixture)).not.toThrow();
    expect(() => acpReviewDeliverableSchema.parse(deliverableWithFindingsFixture)).not.toThrow();
    expect(() => acpReviewDeliverableSchema.parse(noFindingsDeliverableFixture)).not.toThrow();
    expect(() => acpReviewErrorSchema.parse(degradedErrorFixture)).not.toThrow();
  });

  it("keeps sensitive public schema fields bounded", () => {
    expect(deliverableSchemaJson.properties.findings.items.properties.evidence.maxItems).toBe(10);
    expect(
      deliverableSchemaJson.properties.findings.items.properties.evidence.items.properties.quote
        .maxLength,
    ).toBe(600);
    expect(errorSchemaJson.properties.error.properties.details.additionalProperties.type).toEqual([
      "string",
      "number",
      "boolean",
      "null",
    ]);
  });

  it("rejects repo scan mode and target tuples with both pr and sha", () => {
    expect(() =>
      parseAcpReviewRequest({
        mode: "repo_scan",
        target: { repo: "demo-agent/acp-handler" },
      }),
    ).toThrow();

    expect(() =>
      parseAcpReviewRequest({
        mode: "pr",
        target: {
          repo: "demo-agent/acp-handler",
          pr: 42,
          sha: "4d967f2",
        },
      }),
    ).toThrow("Supply exactly one");
  });

  it("requires not-financial-advice acknowledgment for trading focus", () => {
    expect(() =>
      parseAcpReviewRequest({
        mode: "pr",
        target: { repo: "demo-agent/acp-handler", pr: 42 },
        options: {
          public_receipt: true,
          focus: ["trading-risk"],
        },
      }),
    ).toThrow("trading-risk focus");
  });
});

describe("ACP review deliverable builder", () => {
  it("maps internal findings without renaming internal finding fields", () => {
    const finding = findingFixture();
    const mapped = mapFindingToAcpFinding({
      reviewId: "review-1",
      index: 0,
      finding,
    });

    expect(mapped).toMatchObject({
      title: finding.title,
      severity: finding.severity,
      category: finding.category,
      confidence: finding.confidence,
      evidence: finding.evidence,
      reasoning: finding.reasoning,
      reproduction: finding.reproduction,
      recommendation: finding.recommendation,
      whyTestsDoNotAlreadyCoverThis: finding.whyTestsDoNotAlreadyCoverThis,
      suggestedRegressionTest: finding.suggestedRegressionTest,
      minimumFixScope: finding.minimumFixScope,
      requiresPolicyReview: finding.requiresPolicyReview,
      upstreamOrigin: finding.upstreamOrigin,
      finding_id: "review-1-0",
      status: "open",
      receipt_url: null,
    });
    expect(mapped).not.toHaveProperty("label");
  });

  it("builds complete deliverables with pending finding receipt semantics", () => {
    const deliverable = buildAcpReviewDeliverable({
      acpJobId: "43868",
      antfleetJobId: "af_acp_01jz7ra9x0",
      clientAgentWallet: "0x1111111111111111111111111111111111111111",
      statusUrl: "https://www.antfleet.dev/api/v1/acp/review-jobs/af_acp_01jz7ra9x0",
      target: {
        repo: "demo-agent/acp-handler",
        pr: 42,
        headSha: "4d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f001",
        filesReviewed: ["src/settlement.ts"],
      },
      review: {
        reviewId: "review-1",
        modelIds: { anthropic: "claude-opus-4-7", openai: "gpt-5" },
        durationMs: 84_231,
      },
      findings: [
        mapFindingToAcpFinding({
          reviewId: "review-1",
          index: 0,
          finding: findingFixture(),
        }),
      ],
      reviewReceiptUrl: "https://www.antfleet.dev/receipts/review/review-1",
    });

    expect(deliverable.schema_version).toBe(ACP_REVIEW_DELIVERABLE_SCHEMA_VERSION);
    expect(deliverable.status).toBe("complete");
    expect(deliverable.review.degraded).toBe(false);
    expect(deliverable.receipt.state).toBe("finding_receipts_pending");
    expect(deliverable.receipt.receipt_note).toContain("Finding receipts publish after fixes");
  });

  it("marks deliverables receipt_pending when the review receipt URL is missing", () => {
    const noFindings = buildAcpReviewDeliverable({
      acpJobId: "43871",
      antfleetJobId: "af_acp_01jz7rd3x3",
      statusUrl: "https://www.antfleet.dev/api/v1/acp/review-jobs/af_acp_01jz7rd3x3",
      target: {
        repo: "demo-agent/acp-handler",
        pr: 45,
        headSha: "7d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f004",
      },
      review: {
        reviewId: "review-pending-1",
        modelIds: { anthropic: "claude-opus-4-7", openai: "gpt-5" },
      },
      findings: [],
      reviewReceiptUrl: null,
    });
    const withFindings = buildAcpReviewDeliverable({
      acpJobId: "43872",
      antfleetJobId: "af_acp_01jz7re4x4",
      statusUrl: "https://www.antfleet.dev/api/v1/acp/review-jobs/af_acp_01jz7re4x4",
      target: {
        repo: "demo-agent/acp-handler",
        pr: 46,
        headSha: "8d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f005",
      },
      review: {
        reviewId: "review-pending-2",
        modelIds: { anthropic: "claude-opus-4-7", openai: "gpt-5" },
      },
      findings: [
        mapFindingToAcpFinding({
          reviewId: "review-pending-2",
          index: 0,
          finding: findingFixture(),
        }),
      ],
      reviewReceiptUrl: null,
    });

    expect(noFindings.status).toBe("receipt_pending");
    expect(withFindings.status).toBe("receipt_pending");
    expect(noFindings.receipt.state).toBe("unavailable");
    expect(withFindings.receipt.state).toBe("unavailable");
  });

  it("accepts deliverables that omit optional degraded_reason", () => {
    const deliverable = acpReviewDeliverableSchema.parse(noFindingsDeliverableFixture);
    const withoutDegradedReason = {
      ...deliverable,
      review: {
        ...deliverable.review,
        degraded_reason: undefined,
      },
    };
    delete withoutDegradedReason.review.degraded_reason;

    expect(() => acpReviewDeliverableSchema.parse(withoutDegradedReason)).not.toThrow();
  });

  it("builds no-finding deliverables with no-consensus wording", () => {
    const deliverable = buildAcpReviewDeliverable({
      acpJobId: "43869",
      antfleetJobId: "af_acp_01jz7rb1x1",
      statusUrl: "https://www.antfleet.dev/api/v1/acp/review-jobs/af_acp_01jz7rb1x1",
      target: {
        repo: "demo-agent/acp-handler",
        pr: 43,
        headSha: "5d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f002",
      },
      review: {
        reviewId: "review-2",
        modelIds: { anthropic: "claude-opus-4-7", openai: "gpt-5" },
      },
      findings: [],
      reviewReceiptUrl: "https://www.antfleet.dev/receipts/review/review-2",
    });

    expect(deliverable.status).toBe("complete_no_findings");
    expect(deliverable.receipt.state).toBe("no_findings");
    expect(deliverable.receipt.receipt_note).toBe(
      "No two-model consensus findings were emitted for this scope.",
    );
    expect(deliverable.receipt.receipt_note).not.toContain("clean");
  });

  it("builds provider degradation as an error payload, not a success deliverable", () => {
    const error = buildAcpReviewError({
      code: "provider_degraded",
      message: "Fewer than two independent reviewer outputs were available.",
      retryable: true,
      settlement: "escrow_refundable",
    });

    expect(error.schema_version).toBe(ACP_REVIEW_ERROR_SCHEMA_VERSION);
    expect(error.status).toBe("failed");
    expect(() => acpReviewDeliverableSchema.parse(error)).toThrow();
  });

  it("rejects oversized finding quotes and non-scalar error details", () => {
    const oversized = mapFindingToAcpFinding({
      reviewId: "review-oversized",
      index: 0,
      finding: {
        ...findingFixture(),
        evidence: [
          {
            path: "src/settlement.ts",
            startLine: 88,
            endLine: 103,
            symbol: "handleSettlement",
            quote: "x".repeat(601),
          },
        ],
      },
    });

    expect(() => acpReviewFindingSchema.parse(oversized)).toThrow();
    expect(() =>
      buildAcpReviewError({
        code: "internal",
        message: "bad details",
        retryable: false,
        settlement: "operator_review",
        details: { raw: { stack: "secret" } } as never,
      }),
    ).toThrow();
  });

  it("adds trading disclaimer only when requested by the caller", () => {
    const deliverable = buildAcpReviewDeliverable({
      acpJobId: "43870",
      antfleetJobId: "af_acp_01jz7rc2x2",
      statusUrl: "https://www.antfleet.dev/api/v1/acp/review-jobs/af_acp_01jz7rc2x2",
      target: {
        repo: "demo-agent/trading-agent",
        pr: 44,
        headSha: "6d967f2a8f5a6f1d7a8235e8e6a9d2b7c8e9f003",
      },
      review: {
        reviewId: "review-3",
        modelIds: { anthropic: "claude-opus-4-7", openai: "gpt-5" },
      },
      findings: [],
      reviewReceiptUrl: "https://www.antfleet.dev/receipts/review/review-3",
      includeTradingDisclaimer: true,
    });

    expect(deliverable.disclaimer).toBe(ACP_TRADING_DISCLAIMER);
  });
});

describe("ACP review guard helpers", () => {
  it("detects trading-code heuristics that require acknowledgment", () => {
    expect(
      validateTradingAcknowledgment({
        request: { options: { public_receipt: true, max_findings: 10 } },
        repoTopics: ["ACP", "DeFi"],
      }),
    ).toBe(false);

    expect(
      validateTradingAcknowledgment({
        request: {
          options: {
            public_receipt: true,
            max_findings: 10,
            acknowledge_not_financial_advice: true,
          },
        },
        changedFilePaths: ["src/orders/submit.ts"],
      }),
    ).toBe(true);
  });

  it("normalizes rate-limit and repo-cooldown keys", () => {
    expect(acpWalletRateLimitKey("0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD")).toBe(
      "acp:v0:wallet:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    );
    expect(acpRepoCooldownKey("AntFleet/ACP-Handler")).toBe("acp:v0:repo:antfleet/acp-handler");
    expect(() => acpRepoCooldownKey("AntFleet/ACP-Handler/extra")).toThrow();
    expect(() => acpWalletRateLimitKey("not-a-wallet")).toThrow();
  });
});

function findingFixture(): Finding {
  return {
    title: "ACP delivery accepts unsigned settlement callback",
    severity: "high",
    label: "blocking",
    category: "security",
    confidence: "high",
    evidence: [
      {
        path: "src/settlement.ts",
        startLine: 88,
        endLine: 103,
        symbol: "handleSettlement",
        quote: "callback payload is trusted before signature verification",
      },
    ],
    reasoning: "Both reviewers flagged the same unauthenticated settlement path.",
    reproduction: "Send a callback body with status=paid and no valid signature.",
    recommendation: "Verify callback signature before reading settlement status.",
    whyTestsDoNotAlreadyCoverThis: "Existing tests exercise successful settlement only.",
    suggestedRegressionTest: "Reject unsigned settlement callbacks.",
    minimumFixScope: "Verify the callback signature before parsing or trusting settlement status.",
    requiresPolicyReview: false,
    upstreamOrigin: null,
  };
}
