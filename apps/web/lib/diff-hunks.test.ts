import { describe, it, expect } from "vitest";
import {
  countAddedLines,
  parseHunkRanges,
  rangeFallsInsideHunk,
  rangeOverlapsHunk,
} from "./diff-hunks";

describe("parseHunkRanges", () => {
  it("returns [] for null patch (binary file path)", () => {
    expect(parseHunkRanges(null)).toEqual([]);
  });

  it("returns [] for empty patch", () => {
    expect(parseHunkRanges("")).toEqual([]);
  });

  it("parses a single hunk header", () => {
    const patch = "@@ -10,3 +20,5 @@\n context\n-old\n+new\n+new2\n+new3\n";
    expect(parseHunkRanges(patch)).toEqual([{ start: 20, end: 24 }]);
  });

  it("parses a hunk header with implicit counts (@@ -N +M @@)", () => {
    const patch = "@@ -7 +9 @@\n-old\n+new\n";
    expect(parseHunkRanges(patch)).toEqual([{ start: 9, end: 9 }]);
  });

  it("parses multiple hunks in one patch", () => {
    const patch =
      "@@ -1,2 +1,2 @@\n-a\n+A\n b\n@@ -50,3 +50,3 @@\n c\n-d\n+D\n e\n@@ -100,1 +110,2 @@\n-x\n+X\n+Y\n";
    expect(parseHunkRanges(patch)).toEqual([
      { start: 1, end: 2 },
      { start: 50, end: 52 },
      { start: 110, end: 111 },
    ]);
  });

  it("skips hunks where the new-side count is zero (deletion only)", () => {
    const patch = "@@ -10,3 +10,0 @@\n-a\n-b\n-c\n@@ -20,1 +18,1 @@\n-x\n+y\n";
    // First hunk has newCount=0 (deletion-only) — not targetable by a
    // suggestion block. Second hunk parses normally.
    expect(parseHunkRanges(patch)).toEqual([{ start: 18, end: 18 }]);
  });

  it("ignores non-header lines that contain @@ in the body", () => {
    const patch = "@@ -1,3 +1,3 @@\n const PATTERN = /@@ never matches @@/;\n+changed\n";
    expect(parseHunkRanges(patch)).toEqual([{ start: 1, end: 3 }]);
  });
});

describe("rangeFallsInsideHunk", () => {
  const hunks = [
    { start: 10, end: 20 },
    { start: 50, end: 55 },
  ];

  it("accepts a single-line finding inside a hunk", () => {
    expect(rangeFallsInsideHunk(hunks, 15, null)).toBe(true);
    expect(rangeFallsInsideHunk(hunks, 15, 15)).toBe(true);
  });

  it("accepts a range fully inside a single hunk", () => {
    expect(rangeFallsInsideHunk(hunks, 12, 18)).toBe(true);
    expect(rangeFallsInsideHunk(hunks, 50, 55)).toBe(true);
  });

  it("rejects a range outside every hunk", () => {
    expect(rangeFallsInsideHunk(hunks, 5, 8)).toBe(false);
    expect(rangeFallsInsideHunk(hunks, 25, 30)).toBe(false);
    expect(rangeFallsInsideHunk(hunks, 100, null)).toBe(false);
  });

  it("rejects a range that straddles two hunks", () => {
    // 18..51 spans the gap between hunk[0] (ends at 20) and hunk[1]
    // (starts at 50). One suggestion block can't span this.
    expect(rangeFallsInsideHunk(hunks, 18, 51)).toBe(false);
  });

  it("rejects null startLine (file-level finding with no line anchor)", () => {
    expect(rangeFallsInsideHunk(hunks, null, null)).toBe(false);
    expect(rangeFallsInsideHunk(hunks, null, 15)).toBe(false);
  });

  it("rejects non-positive startLine defensively", () => {
    expect(rangeFallsInsideHunk(hunks, 0, 0)).toBe(false);
    expect(rangeFallsInsideHunk(hunks, -1, -1)).toBe(false);
  });

  it("returns false against no hunks (binary or no-patch file)", () => {
    expect(rangeFallsInsideHunk([], 15, 15)).toBe(false);
  });

  it("treats an endLine < startLine as a single-line finding", () => {
    // Defensive: GitHub occasionally returns inverted ranges in odd
    // edge cases. Fall back to startLine as the anchor.
    expect(rangeFallsInsideHunk(hunks, 15, 12)).toBe(true);
  });
});

describe("rangeOverlapsHunk", () => {
  const hunks = [
    { start: 10, end: 20 },
    { start: 50, end: 55 },
  ];

  it("accepts a range fully inside a hunk", () => {
    expect(rangeOverlapsHunk(hunks, 12, 18)).toBe(true);
    expect(rangeOverlapsHunk(hunks, 50, 55)).toBe(true);
  });

  it("accepts a range that partially overlaps a hunk", () => {
    expect(rangeOverlapsHunk(hunks, 5, 10)).toBe(true);
    expect(rangeOverlapsHunk(hunks, 18, 25)).toBe(true);
  });

  it("accepts a hunk fully inside a broader finding range", () => {
    expect(rangeOverlapsHunk(hunks, 1, 100)).toBe(true);
    expect(rangeOverlapsHunk(hunks, 45, 60)).toBe(true);
  });

  it("rejects a range in the same file but disjoint from every hunk", () => {
    expect(rangeOverlapsHunk(hunks, 1, 9)).toBe(false);
    expect(rangeOverlapsHunk(hunks, 21, 49)).toBe(false);
    expect(rangeOverlapsHunk(hunks, 56, 60)).toBe(false);
  });

  it("rejects null startLine (file-level finding with no line anchor)", () => {
    expect(rangeOverlapsHunk(hunks, null, null)).toBe(false);
    expect(rangeOverlapsHunk(hunks, null, 15)).toBe(false);
  });

  it("treats endLine < startLine as a single-line finding", () => {
    expect(rangeOverlapsHunk(hunks, 15, 12)).toBe(true);
    expect(rangeOverlapsHunk(hunks, 25, 12)).toBe(false);
  });
});

describe("countAddedLines", () => {
  it("counts every line starting with '+' except the +++ header", () => {
    const patch =
      "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,4 @@\n const x = 1;\n-const y = 2;\n+const y = 3;\n+const z = 4;\n const w = 5;\n";
    expect(countAddedLines(patch)).toBe(2);
  });

  it("returns 0 for an empty patch", () => {
    expect(countAddedLines("")).toBe(0);
  });

  it("returns 0 for a deletion-only patch", () => {
    const patch = "@@ -1,2 +1,0 @@\n-removed1\n-removed2\n";
    expect(countAddedLines(patch)).toBe(0);
  });

  it("does not double-count the +++ header line", () => {
    const patch = "--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n+only-add\n";
    expect(countAddedLines(patch)).toBe(1);
  });
});
