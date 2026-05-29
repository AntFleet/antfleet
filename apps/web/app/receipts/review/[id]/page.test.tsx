import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ReviewReceiptPage from "./page";

const queryMocks = vi.hoisted(() => ({
  loadPublicReviewReceipt: vi.fn(),
}));

vi.mock("@/db/queries", () => queryMocks);

function normalize(html: string): string {
  return html
    .replace(/<!--\s*-->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    reviewId: "review-1",
    repoHash: "repo-hash",
    owner: "antfleet",
    repo: "x402-fixture",
    prNumber: 1,
    commitSha: "abcdef1234567890",
    createdAt: new Date("2026-05-29T00:00:00Z"),
    processingStatus: "done",
    processingError: null,
    timingMs: 1000,
    costEstimatedUsd: "0.25",
    agreementDecision: {},
    jobId: "job-1",
    paymentRail: "x402",
    jobStatus: "complete",
    failureMode: null,
    failureMessage: null,
    x402PayTo: "0x000000000000000000000000000000000000dEaD",
    callerWallet: "0x0000000000000000000000000000000000000001",
    settlementStatus: "settled",
    findings: [],
    ...overrides,
  };
}

async function render(id = "review-1") {
  const element = await ReviewReceiptPage({ params: Promise.resolve({ id }) });
  return normalize(renderToString(element));
}

describe("/receipts/review/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders complete review findings with links to finding receipts", async () => {
    queryMocks.loadPublicReviewReceipt.mockResolvedValue(
      row({
        findings: [
          {
            findingId: "finding-1",
            findingIndex: 0,
            severity: "HIGH",
            category: "security",
            title: "Validate signer before settlement",
          },
          {
            findingId: "finding-2",
            findingIndex: 1,
            severity: "MEDIUM",
            category: "logic",
            title: "Preserve idempotency on retries",
          },
        ],
      }),
    );

    const html = await render();

    expect(html).toContain("Validate signer before settlement");
    expect(html).toContain("Preserve idempotency on retries");
    expect(html).toContain('/receipts/finding-1"');
    expect(html).toContain('/receipts/finding-2"');
  });

  it("renders the exact clean-review copy for zero-finding reviews", async () => {
    queryMocks.loadPublicReviewReceipt.mockResolvedValue(row());

    const html = await render();

    expect(html).toContain("No findings — clean review.");
  });

  it("renders failed reviews with the Payment not settled literal", async () => {
    queryMocks.loadPublicReviewReceipt.mockResolvedValue(
      row({
        jobStatus: "failed",
        failureMode: "provider_error",
        failureMessage: null,
        settlementStatus: "not_settled",
      }),
    );

    const html = await render();

    expect(html).toContain("provider_error");
    expect(html).toContain("Payment not settled");
  });

  it("renders channel-rail review receipts without x402 settlement details", async () => {
    queryMocks.loadPublicReviewReceipt.mockResolvedValue(
      row({
        paymentRail: "channel",
        settlementStatus: null,
        callerWallet: null,
        x402PayTo: null,
      }),
    );

    const html = await render();

    expect(html).toContain("channel");
    expect(html).toContain("Rail");
    expect(html).not.toContain("Pay to");
    expect(html).not.toContain("channel treasury");
  });
});
