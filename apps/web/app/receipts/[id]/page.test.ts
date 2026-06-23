import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import type { PublicReceiptDetailRow } from "@/db/queries";

vi.mock("@/db/queries", () => ({
  loadPublicReceiptDetail: vi.fn(),
  loadPublicFindingEvidenceBundle: vi.fn(),
}));
vi.mock("@/lib/daybreak-gates-env", () => ({ isEvidenceBundleEnabled: vi.fn() }));

import ReceiptDetailPage, { generateMetadata } from "./page";
import { loadPublicFindingEvidenceBundle, loadPublicReceiptDetail } from "@/db/queries";
import { isEvidenceBundleEnabled } from "@/lib/daybreak-gates-env";

// Only the fields the retracted path + generateMetadata read matter; the
// retracted branch short-circuits before toDisplayReceiptDetail, so a partial
// row cast is sufficient for these tests.
const row = (over: Partial<PublicReceiptDetailRow> = {}): PublicReceiptDetailRow =>
  ({
    findingId: "abcd1234-0",
    findingIndex: 0,
    status: "closed",
    severity: "high",
    label: "blocking",
    category: "security",
    title: "Sensitive claim title",
    repoHash: "0123456789abcdef",
    prNumber: 42,
    closureSha: "deadbeef0000",
    closureCommentUrl: "https://github.com/AntFleet/bench-demo/pull/42#issuecomment-1",
    closedAt: new Date("2026-06-20T12:00:00Z"),
    reviewId: "11111111-1111-4111-8111-111111111111",
    prCommentUrl: "https://github.com/AntFleet/bench-demo/pull/42#issuecomment-0",
    reviewCreatedAt: new Date("2026-06-20T10:00:00Z"),
    timingMs: 2100,
    costEstimatedUsd: "0.0500",
    providerModelIds: { anthropic: "m1", openai: "m2" },
    providerResponses: {
      perProvider: [
        { name: "anthropic", ms: 1000, ok: true },
        { name: "openai", ms: 1100, ok: true },
      ],
    },
    agreementDecision: {
      agreed: [
        {
          severity: "high",
          category: "security",
          title: "Sensitive claim title",
          reasoning: "reachable from the public handler",
          recommendation: "guard the value",
          evidence: [{ path: "src/handler.ts", startLine: 12, endLine: 12 }],
        },
      ],
    },
    retractedAt: null,
    retractionReason: null,
    ...over,
  }) as PublicReceiptDetailRow;

const params = Promise.resolve({ id: "abcd1234-0" });
const mockLoad = loadPublicReceiptDetail as ReturnType<typeof vi.fn>;
const mockEvidenceBundle = loadPublicFindingEvidenceBundle as ReturnType<typeof vi.fn>;
const mockEvidenceEnabled = isEvidenceBundleEnabled as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockEvidenceEnabled.mockReturnValue(false);
  mockEvidenceBundle.mockResolvedValue(null);
});

describe("receipts detail generateMetadata", () => {
  it("indexes a normal receipt with the claim in the title", async () => {
    mockLoad.mockResolvedValue(row());
    const meta = await generateMetadata({ params });
    expect(meta.robots).toBeUndefined();
    expect(String(meta.title)).toContain("Sensitive claim title");
    expect(String(meta.description)).toContain("high");
    expect(mockEvidenceBundle).not.toHaveBeenCalled();
  });

  it("deindexes a retracted receipt and strips the claim from the title", async () => {
    mockLoad.mockResolvedValue(row({ retractedAt: new Date("2026-05-30") }));
    const meta = await generateMetadata({ params });
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(String(meta.title)).not.toContain("Sensitive claim title");
    expect(mockEvidenceBundle).not.toHaveBeenCalled();
  });

  it("does not index an open public finding as a receipt", async () => {
    mockLoad.mockResolvedValue(row({ status: "open", closedAt: null }));
    const meta = await generateMetadata({ params });
    expect(String(meta.title)).toContain("Receipt not found");
    expect(mockEvidenceBundle).not.toHaveBeenCalled();
  });
});

describe("receipts detail body — retracted short-circuit", () => {
  it("renders a retraction notice with none of the claim text", async () => {
    mockLoad.mockResolvedValue(
      row({
        retractedAt: new Date("2026-05-30"),
        retractionReason: "False positive on a safe pattern.",
      }),
    );
    const html = renderToStaticMarkup((await ReceiptDetailPage({ params })) as ReactElement);
    expect(html).toContain("This finding has been retracted");
    expect(html).toContain("False positive on a safe pattern.");
    expect(html).not.toContain("Sensitive claim title");
    expect(mockEvidenceBundle).not.toHaveBeenCalled();
  });
});

describe("receipts detail body — evidence bundle", () => {
  it("does not query or render evidence while the feature flag is off", async () => {
    mockLoad.mockResolvedValue(row());
    const html = renderToStaticMarkup((await ReceiptDetailPage({ params })) as ReactElement);
    expect(mockEvidenceBundle).not.toHaveBeenCalled();
    expect(html).not.toContain("Evidence");
    expect(html).not.toContain("no evidence");
  });

  it("rejects open public findings before rendering the claim", async () => {
    mockLoad.mockResolvedValue(row({ status: "open", closedAt: null }));
    await expect(ReceiptDetailPage({ params })).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(mockEvidenceBundle).not.toHaveBeenCalled();
  });

  it("keeps persisted severity when enabled evidence is empty", async () => {
    mockEvidenceEnabled.mockReturnValue(true);
    mockLoad.mockResolvedValue(row());
    const html = renderToStaticMarkup((await ReceiptDetailPage({ params })) as ReactElement);
    expect(mockEvidenceBundle).toHaveBeenCalledWith("abcd1234-0");
    expect(html).toContain("no evidence");
    expect(html).not.toContain("public severity adjusted");
    expect(html).toContain("high");
  });

  it("treats malformed non-renderable slots as empty evidence", async () => {
    mockEvidenceEnabled.mockReturnValue(true);
    mockLoad.mockResolvedValue(row());
    mockEvidenceBundle.mockResolvedValue({
      findingId: "abcd1234-0",
      reviewId: "11111111-1111-4111-8111-111111111111",
      reviewAttempt: 1,
      affectedSha: "deadbeef0000",
      pocSnippet: { value: { nope: "x" } },
      reproductionCommand: { value: { nope: "x" } },
      callPathTrace: { value: { entryPoint: null, callPath: [] } },
      bundleStatus: "complete",
      createdAt: new Date("2026-06-20T12:00:00Z"),
      updatedAt: new Date("2026-06-20T12:00:00Z"),
    });
    const html = renderToStaticMarkup((await ReceiptDetailPage({ params })) as ReactElement);
    expect(html).toContain("no evidence");
    expect(html).not.toContain("public severity adjusted");
  });
});
