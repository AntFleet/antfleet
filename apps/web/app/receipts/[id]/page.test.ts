import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import type { PublicReceiptDetailRow } from "@/db/queries";

vi.mock("@/db/queries", () => ({ loadPublicReceiptDetail: vi.fn() }));

import ReceiptDetailPage, { generateMetadata } from "./page";
import { loadPublicReceiptDetail } from "@/db/queries";

// Only the fields the retracted path + generateMetadata read matter; the
// retracted branch short-circuits before toDisplayReceiptDetail, so a partial
// row cast is sufficient for these tests.
const row = (over: Partial<PublicReceiptDetailRow> = {}): PublicReceiptDetailRow =>
  ({
    findingId: "abcd1234-0",
    severity: "high",
    category: "security",
    title: "Sensitive claim title",
    closureSha: "deadbeef0000",
    retractedAt: null,
    retractionReason: null,
    ...over,
  }) as PublicReceiptDetailRow;

const params = Promise.resolve({ id: "abcd1234-0" });
const mockLoad = loadPublicReceiptDetail as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe("receipts detail generateMetadata", () => {
  it("indexes a normal receipt with the claim in the title", async () => {
    mockLoad.mockResolvedValue(row());
    const meta = await generateMetadata({ params });
    expect(meta.robots).toBeUndefined();
    expect(String(meta.title)).toContain("Sensitive claim title");
  });

  it("deindexes a retracted receipt and strips the claim from the title", async () => {
    mockLoad.mockResolvedValue(row({ retractedAt: new Date("2026-05-30") }));
    const meta = await generateMetadata({ params });
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(String(meta.title)).not.toContain("Sensitive claim title");
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
  });
});
