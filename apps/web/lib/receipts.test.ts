import { describe, expect, it } from "vitest";
import type { PublicReceiptRow } from "@/db/queries";
import { formatRelativeTime, toDisplayReceipt } from "./receipts";

const BASE_NOW = new Date("2026-05-17T12:00:00.000Z");

const SAMPLE: PublicReceiptRow = {
  findingId: "83e79770-1",
  severity: "High",
  category: "Security",
  title: "SQL injection in getOrder handler",
  // 64-hex sha256 — only first 8 should ever leave the server
  repoHash: "a3f2c4b1d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5",
  prNumber: 14,
  closureSha: "1ee2fd9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e",
  closureCommentUrl: "https://github.com/example/repo/issues/14#issuecomment-1234",
  closedAt: new Date("2026-05-17T08:00:00.000Z"), // 4 hours before BASE_NOW
};

describe("toDisplayReceipt", () => {
  it("anonymizes repo with an 8-char hash prefix label", () => {
    const display = toDisplayReceipt(SAMPLE, BASE_NOW);
    expect(display.repoLabel).toBe("repo a3f2c4b1");
  });

  it("formats prLabel and shaLabel to short, human-scannable forms", () => {
    const display = toDisplayReceipt(SAMPLE, BASE_NOW);
    expect(display.prLabel).toBe("PR #14");
    expect(display.shaLabel).toBe("1ee2fd9");
  });

  it("returns null shaLabel, relativeClosedAt, and closedAtIso when closure columns are null", () => {
    const display = toDisplayReceipt(
      { ...SAMPLE, closureSha: null, closedAt: null },
      BASE_NOW,
    );
    expect(display.shaLabel).toBeNull();
    expect(display.relativeClosedAt).toBeNull();
    expect(display.closedAtIso).toBeNull();
  });

  it("exposes closedAtIso as a stable ISO 8601 string for cursor pagination", () => {
    const display = toDisplayReceipt(SAMPLE, BASE_NOW);
    expect(display.closedAtIso).toBe("2026-05-17T08:00:00.000Z");
  });

  it("preserves the closureCommentUrl exactly — it is the receipt artifact", () => {
    const display = toDisplayReceipt(SAMPLE, BASE_NOW);
    expect(display.receiptUrl).toBe(SAMPLE.closureCommentUrl);
  });

  it("preserves severity/category/title verbatim (already-public PR comment text)", () => {
    const display = toDisplayReceipt(SAMPLE, BASE_NOW);
    expect(display.severity).toBe("High");
    expect(display.category).toBe("Security");
    expect(display.title).toBe("SQL injection in getOrder handler");
  });
});

describe("formatRelativeTime", () => {
  const now = BASE_NOW;

  it("clamps future timestamps to 'just now' rather than leaking data noise", () => {
    const future = new Date(now.getTime() + 60_000);
    expect(formatRelativeTime(now, future)).toBe("just now");
  });

  it("uses 'just now' for deltas under one minute", () => {
    expect(formatRelativeTime(now, new Date(now.getTime() - 30_000))).toBe("just now");
  });

  it("formats minutes with correct singular/plural", () => {
    expect(formatRelativeTime(now, new Date(now.getTime() - 60_000))).toBe("1 minute ago");
    expect(formatRelativeTime(now, new Date(now.getTime() - 5 * 60_000))).toBe("5 minutes ago");
  });

  it("formats hours", () => {
    expect(formatRelativeTime(now, new Date(now.getTime() - 60 * 60_000))).toBe("1 hour ago");
    expect(formatRelativeTime(now, new Date(now.getTime() - 4 * 60 * 60_000))).toBe("4 hours ago");
  });

  it("formats days", () => {
    expect(formatRelativeTime(now, new Date(now.getTime() - 24 * 60 * 60_000))).toBe("1 day ago");
    expect(formatRelativeTime(now, new Date(now.getTime() - 3 * 24 * 60 * 60_000))).toBe(
      "3 days ago",
    );
  });

  it("formats weeks then months then years at the right breakpoints", () => {
    const week = 7 * 24 * 60 * 60_000;
    const month = 30 * 24 * 60 * 60_000;
    const year = 365 * 24 * 60 * 60_000;
    expect(formatRelativeTime(now, new Date(now.getTime() - 2 * week))).toBe("2 weeks ago");
    expect(formatRelativeTime(now, new Date(now.getTime() - 2 * month))).toBe("2 months ago");
    expect(formatRelativeTime(now, new Date(now.getTime() - 2 * year))).toBe("2 years ago");
  });
});
