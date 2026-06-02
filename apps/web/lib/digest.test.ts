import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityWindow, PublicReceiptRow } from "@/db/queries";
import type { CrossRepoReceiptsWindow } from "@/lib/receipts";

const mocks = vi.hoisted(() => ({
  activityWindow: vi.fn(),
  loadTopClosuresBetween: vi.fn(),
  loadCrossRepoReceiptsBetween: vi.fn(),
}));

vi.mock("@/db/queries", () => ({
  activityWindow: mocks.activityWindow,
  loadTopClosuresBetween: mocks.loadTopClosuresBetween,
}));

vi.mock("@/lib/receipts", () => ({
  loadCrossRepoReceiptsBetween: mocks.loadCrossRepoReceiptsBetween,
}));

import { loadDigestForWeek } from "./digest";

const COUNTS: ActivityWindow = {
  reviewsRun: 16,
  findingsAgreed: 19,
  receiptsClosed: 0,
  reactionsObserved: 0,
};

const TOP_CLOSURES: PublicReceiptRow[] = [];

const CROSS_REPO: CrossRepoReceiptsWindow = {
  total: 8,
  lastResolvedAt: new Date("2026-05-30T06:00:33.192Z"),
  recent: [
    {
      id: "outgoing-1",
      sourceFindingId: "aeon-258-1",
      upstreamOwner: "aaronjmars",
      upstreamRepo: "aeon",
      upstreamPrNumber: 268,
      resolvedAt: new Date("2026-05-30T06:00:33.192Z"),
      resolutionSha: "c87405f4e73d11f714ec58c3eea75977c8ef99fb",
      prUrl: "https://github.com/aaronjmars/aeon/pull/268",
      closureMethod: "merged",
    },
  ],
};

describe("loadDigestForWeek", () => {
  beforeEach(() => {
    mocks.activityWindow.mockReset();
    mocks.loadTopClosuresBetween.mockReset();
    mocks.loadCrossRepoReceiptsBetween.mockReset();
  });

  it("adds receipt-eligible cross-repo fixes to the weekly receiptsClosed count", async () => {
    mocks.activityWindow.mockResolvedValue(COUNTS);
    mocks.loadTopClosuresBetween.mockResolvedValue(TOP_CLOSURES);
    mocks.loadCrossRepoReceiptsBetween.mockResolvedValue(CROSS_REPO);

    const digest = await loadDigestForWeek(
      "2026-06-01",
      new Date("2026-06-02T00:00:00.000Z"),
    );

    expect(digest).not.toBeNull();
    expect(digest?.since.toISOString()).toBe("2026-05-25T00:00:00.000Z");
    expect(digest?.until.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(digest?.counts).toEqual({
      reviewsRun: 16,
      findingsAgreed: 19,
      receiptsClosed: 8,
      reactionsObserved: 0,
    });
    expect(digest?.crossRepoReceipts).toEqual(CROSS_REPO.recent);
    expect(mocks.loadCrossRepoReceiptsBetween).toHaveBeenCalledWith(
      new Date("2026-05-25T00:00:00.000Z"),
      new Date("2026-06-01T00:00:00.000Z"),
      3,
    );
  });
});
