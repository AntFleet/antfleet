import { z } from "zod";
import type { Finding } from "@/lib/review-types";

export const ACP_REVIEW_REQUEST_SCHEMA_ID =
  "https://www.antfleet.dev/schemas/acp/review-request-v0.json";
export const ACP_REVIEW_DELIVERABLE_SCHEMA_ID =
  "https://www.antfleet.dev/schemas/acp/review-deliverable-v0.json";
export const ACP_REVIEW_ERROR_SCHEMA_ID =
  "https://www.antfleet.dev/schemas/acp/review-error-v0.json";

export const ACP_REVIEW_DELIVERABLE_SCHEMA_VERSION = "antfleet.acp.review.deliverable.v0";
export const ACP_REVIEW_ERROR_SCHEMA_VERSION = "antfleet.acp.review.error.v0";
export const ACP_REVIEW_PROVIDER_AGENT = "AntFleet";

export const ACP_TRADING_DISCLAIMER =
  "AntFleet reviews code structure and implementation risks. It does not evaluate trading profitability, market strategy, regulatory suitability, portfolio risk, or whether an autonomous agent should trade. Findings are not financial advice.";

const focusSchema = z.enum([
  "security",
  "api-contract",
  "data-loss",
  "concurrency",
  "trading-risk",
  "build-release",
]);

const repoTargetSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const walletSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const safeDetailSchema = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);

export const acpReviewRequestSchema = z
  .object({
    mode: z.literal("pr"),
    target: z
      .object({
        repo: repoTargetSchema,
        pr: z.number().int().min(1).optional(),
        sha: z
          .string()
          .regex(/^[0-9a-fA-F]{7,64}$/)
          .optional(),
      })
      .strict(),
    client: z
      .object({
        agent_wallet: walletSchema.optional(),
        agent_name: z.string().max(120).optional(),
        contact_email: z.email().optional(),
      })
      .strict()
      .optional(),
    options: z
      .object({
        public_receipt: z.literal(true).default(true),
        focus: z.array(focusSchema).max(5).optional(),
        max_findings: z.number().int().min(0).max(20).default(10),
        acknowledge_not_financial_advice: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasPr = value.target.pr !== undefined;
    const hasSha = value.target.sha !== undefined;
    if (hasPr === hasSha) {
      ctx.addIssue({
        code: "custom",
        path: ["target"],
        message: "Supply exactly one target.pr or target.sha.",
      });
    }
    if (
      value.options?.focus?.includes("trading-risk") &&
      value.options.acknowledge_not_financial_advice !== true
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["options", "acknowledge_not_financial_advice"],
        message: "trading-risk focus requires not-financial-advice acknowledgment.",
      });
    }
  });

export type AcpReviewRequest = z.infer<typeof acpReviewRequestSchema>;

const acpEvidenceSchema = z
  .object({
    path: z.string().max(512),
    startLine: z.number().int().min(1).nullable(),
    endLine: z.number().int().min(1).nullable(),
    symbol: z.string().max(160).nullable(),
    quote: z.string().max(600).nullable(),
  })
  .strict();

export const acpReviewFindingSchema = z
  .object({
    finding_id: z.string().max(160),
    title: z.string().max(240),
    severity: z.enum(["critical", "high", "medium", "low"]),
    category: z.enum([
      "bug",
      "security",
      "performance",
      "concurrency",
      "api-contract",
      "data-loss",
      "test-gap",
      "docs-gap",
      "build-release",
      "maintainability",
    ]),
    confidence: z.enum(["high", "medium", "low"]),
    evidence: z.array(acpEvidenceSchema).max(10),
    reasoning: z.string().max(4000),
    reproduction: z.string().max(4000).nullable(),
    recommendation: z.string().max(4000),
    whyTestsDoNotAlreadyCoverThis: z.string().max(2000),
    suggestedRegressionTest: z.string().max(2000).nullable(),
    minimumFixScope: z.string().max(2000),
    requiresPolicyReview: z.boolean(),
    upstreamOrigin: z
      .object({
        package: z.string().max(200),
        reason: z.string().max(1000),
      })
      .strict()
      .nullable(),
    status: z.enum(["open", "closed", "superseded", "not_posted"]),
    receipt_url: z.url().nullable().optional(),
  })
  .strict();

export type AcpReviewFinding = z.infer<typeof acpReviewFindingSchema>;

export const acpReviewDeliverableSchema = z
  .object({
    schema_version: z.literal(ACP_REVIEW_DELIVERABLE_SCHEMA_VERSION),
    status: z.enum(["complete", "complete_no_findings", "receipt_pending"]),
    job: z
      .object({
        acp_job_id: z.string().max(160),
        antfleet_job_id: z.string().max(160),
        provider_agent: z.string().max(120),
        client_agent_wallet: walletSchema.optional(),
        status_url: z.url(),
      })
      .strict(),
    target: z
      .object({
        repo: z.string().max(260),
        mode: z.literal("pr"),
        pr: z.number().int().min(1).optional(),
        head_sha: z.string().regex(/^[0-9a-fA-F]{7,64}$/),
        files_reviewed: z.array(z.string().max(512)).optional(),
      })
      .strict(),
    review: z
      .object({
        review_id: z.string().max(160),
        agreement_mode: z.literal("unanimous"),
        reviewer_count: z.literal(2),
        degraded: z.literal(false),
        degraded_reason: z.null().optional(),
        model_ids: z.record(z.string(), z.string().max(160)),
        duration_ms: z.number().int().min(0).optional(),
      })
      .strict(),
    receipt: z
      .object({
        state: z.enum([
          "review_receipt_ready",
          "finding_receipts_pending",
          "no_findings",
          "unavailable",
        ]),
        review_receipt_url: z.url().nullable(),
        finding_receipt_urls: z.array(z.url()),
        receipt_note: z.string().max(500).optional(),
      })
      .strict(),
    findings: z.array(acpReviewFindingSchema),
    disclaimer: z.string().max(500).optional(),
  })
  .strict();

export type AcpReviewDeliverable = z.infer<typeof acpReviewDeliverableSchema>;

export const acpReviewErrorCodes = [
  "invalid_input",
  "repo_not_accessible",
  "private_repo_not_supported",
  "pr_not_found",
  "pr_not_open",
  "sha_not_in_open_pr",
  "sha_ambiguous",
  "no_reviewable_files",
  "rate_limited",
  "provider_degraded",
  "provider_error",
  "timeout",
  "cost_cap_exceeded",
  "internal",
] as const;

export const acpReviewErrorSchema = z
  .object({
    schema_version: z.literal(ACP_REVIEW_ERROR_SCHEMA_VERSION),
    status: z.literal("failed"),
    error: z
      .object({
        code: z.enum(acpReviewErrorCodes),
        message: z.string().max(1000),
        retryable: z.boolean(),
        settlement: z.enum([
          "not_charged",
          "escrow_refundable",
          "escrow_releasable",
          "operator_review",
        ]),
        details: z.record(z.string(), safeDetailSchema).optional(),
      })
      .strict(),
  })
  .strict();

export type AcpReviewError = z.infer<typeof acpReviewErrorSchema>;
export type AcpReviewErrorCode = (typeof acpReviewErrorCodes)[number];

export function parseAcpReviewRequest(value: unknown): AcpReviewRequest {
  return acpReviewRequestSchema.parse(value);
}

export function normalizeAcpTargetRepo(repo: string): { owner: string; repo: string; key: string } {
  const parsed = repoTargetSchema.parse(repo);
  const parts = parsed.split("/");
  const [owner, name] = parts;
  if (parts.length !== 2 || owner === undefined || name === undefined) {
    throw new Error("invalid ACP target repo");
  }
  return { owner, repo: name, key: `${owner.toLowerCase()}/${name.toLowerCase()}` };
}

export function shouldRequireTradingAcknowledgment(args: {
  request: Pick<AcpReviewRequest, "options">;
  repoName?: string | null;
  repoDescription?: string | null;
  repoTopics?: ReadonlyArray<string> | null;
  changedFilePaths?: ReadonlyArray<string> | null;
}): boolean {
  if (args.request.options?.focus?.includes("trading-risk")) return true;
  return hasTradingCodeSignal(args);
}

export function validateTradingAcknowledgment(args: {
  request: Pick<AcpReviewRequest, "options">;
  repoName?: string | null;
  repoDescription?: string | null;
  repoTopics?: ReadonlyArray<string> | null;
  changedFilePaths?: ReadonlyArray<string> | null;
}): boolean {
  if (!shouldRequireTradingAcknowledgment(args)) return true;
  return args.request.options?.acknowledge_not_financial_advice === true;
}

export function mapFindingToAcpFinding(args: {
  reviewId: string;
  index: number;
  finding: Finding;
  status?: AcpReviewFinding["status"];
  receiptUrl?: string | null;
}): AcpReviewFinding {
  const { label: _internalLabel, ...finding } = args.finding;
  return {
    ...finding,
    finding_id: `${args.reviewId}-${args.index}`,
    status: args.status ?? "open",
    receipt_url: args.receiptUrl ?? null,
  };
}

export function buildAcpReviewDeliverable(args: {
  acpJobId: string;
  antfleetJobId: string;
  clientAgentWallet?: string | null;
  statusUrl: string;
  target: {
    repo: string;
    pr?: number;
    headSha: string;
    filesReviewed?: string[];
  };
  review: {
    reviewId: string;
    modelIds: Record<string, string>;
    durationMs?: number;
  };
  findings: AcpReviewFinding[];
  reviewReceiptUrl: string | null;
  receiptPending?: boolean;
  includeTradingDisclaimer?: boolean;
}): AcpReviewDeliverable {
  const findingReceiptUrls = args.findings
    .map((finding) => finding.receipt_url)
    .filter((url): url is string => url !== null && url !== undefined);
  const hasFindings = args.findings.length > 0;
  const receiptState = receiptStateFor({
    hasFindings,
    reviewReceiptUrl: args.reviewReceiptUrl,
    receiptPending: args.receiptPending ?? false,
  });
  const isReceiptPending = args.receiptPending === true || args.reviewReceiptUrl === null;
  const deliverable: AcpReviewDeliverable = {
    schema_version: ACP_REVIEW_DELIVERABLE_SCHEMA_VERSION,
    status: isReceiptPending
      ? "receipt_pending"
      : hasFindings
        ? "complete"
        : "complete_no_findings",
    job: {
      acp_job_id: args.acpJobId,
      antfleet_job_id: args.antfleetJobId,
      provider_agent: ACP_REVIEW_PROVIDER_AGENT,
      ...(args.clientAgentWallet ? { client_agent_wallet: args.clientAgentWallet } : {}),
      status_url: args.statusUrl,
    },
    target: {
      repo: args.target.repo,
      mode: "pr",
      ...(args.target.pr !== undefined ? { pr: args.target.pr } : {}),
      head_sha: args.target.headSha,
      ...(args.target.filesReviewed !== undefined
        ? { files_reviewed: args.target.filesReviewed }
        : {}),
    },
    review: {
      review_id: args.review.reviewId,
      agreement_mode: "unanimous",
      reviewer_count: 2,
      degraded: false,
      degraded_reason: null,
      model_ids: args.review.modelIds,
      ...(args.review.durationMs !== undefined ? { duration_ms: args.review.durationMs } : {}),
    },
    receipt: {
      state: receiptState,
      review_receipt_url: args.reviewReceiptUrl,
      finding_receipt_urls: findingReceiptUrls,
      receipt_note: receiptNoteFor(receiptState),
    },
    findings: args.findings,
    ...(args.includeTradingDisclaimer ? { disclaimer: ACP_TRADING_DISCLAIMER } : {}),
  };
  return acpReviewDeliverableSchema.parse(deliverable);
}

export function buildAcpReviewError(args: {
  code: AcpReviewErrorCode;
  message: string;
  retryable: boolean;
  settlement: AcpReviewError["error"]["settlement"];
  details?: Record<string, string | number | boolean | null>;
}): AcpReviewError {
  return acpReviewErrorSchema.parse({
    schema_version: ACP_REVIEW_ERROR_SCHEMA_VERSION,
    status: "failed",
    error: {
      code: args.code,
      message: args.message,
      retryable: args.retryable,
      settlement: args.settlement,
      ...(args.details !== undefined ? { details: args.details } : {}),
    },
  });
}

export function acpWalletRateLimitKey(wallet: string): string {
  return `acp:v0:wallet:${walletSchema.parse(wallet).toLowerCase()}`;
}

export function acpRepoCooldownKey(repo: string): string {
  return `acp:v0:repo:${normalizeAcpTargetRepo(repo).key}`;
}

function receiptStateFor(args: {
  hasFindings: boolean;
  reviewReceiptUrl: string | null;
  receiptPending: boolean;
}): AcpReviewDeliverable["receipt"]["state"] {
  if (args.receiptPending || args.reviewReceiptUrl === null) return "unavailable";
  if (!args.hasFindings) return "no_findings";
  return "finding_receipts_pending";
}

function receiptNoteFor(state: AcpReviewDeliverable["receipt"]["state"]): string {
  switch (state) {
    case "no_findings":
      return "No two-model consensus findings were emitted for this scope.";
    case "finding_receipts_pending":
      return "Review receipt is ready. Finding receipts publish after fixes are detected and SHA-pinned.";
    case "review_receipt_ready":
      return "Review receipt is ready.";
    case "unavailable":
      return "Review completed, but public receipt publication is still pending. Poll job.status_url for updates.";
  }
}

function hasTradingCodeSignal(args: {
  repoName?: string | null;
  repoDescription?: string | null;
  repoTopics?: ReadonlyArray<string> | null;
  changedFilePaths?: ReadonlyArray<string> | null;
}): boolean {
  const topicSignals = new Set([
    "trading",
    "defi",
    "dex",
    "market-maker",
    "arbitrage",
    "portfolio",
    "execution",
  ]);
  if (args.repoTopics?.some((topic) => topicSignals.has(topic.toLowerCase()))) return true;

  const text = `${args.repoName ?? ""} ${args.repoDescription ?? ""}`.toLowerCase();
  if (/\b(trading|trade|trader|market-maker|arbitrage|portfolio|dex|exchange)\b/.test(text)) {
    return true;
  }

  return (
    args.changedFilePaths?.some((path) =>
      /(^|[/_.-])(trade|trading|orders|positions|portfolio|strategy|execution|exchange|broker)([/_.-]|$)/i.test(
        path,
      ),
    ) ?? false
  );
}
