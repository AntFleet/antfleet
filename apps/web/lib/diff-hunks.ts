// Patch Agent v1.5 — unified-diff hunk extraction.
//
// GitHub suggestion blocks can only modify lines that appear inside a PR's
// diff hunks. Before posting a ```suggestion fence we have to verify that
// every line the proposed patch targets lies inside a changed region of the
// file as it appears on the PR head.
//
// This module parses a single file's unified diff (the `patch` field on
// GitHub's listFiles response) into `{ start, end }` ranges expressed against
// the NEW-side line numbers (the destination file post-merge). The
// reviewer's evidence is also expressed against the head, so a simple
// numeric overlap check is sufficient.
//
// Pure functions only — no I/O, no clock.

export type HunkRange = {
  // Inclusive 1-based new-side line numbers.
  start: number;
  end: number;
};

// Matches the unified-diff hunk header: @@ -<oldStart>,<oldCount> +<newStart>,<newCount> @@
// The count component is optional in unified-diff: "@@ -3 +3 @@" is a single-
// line hunk on both sides. Treat a missing count as 1.
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u;

/**
 * Parse a unified-diff patch body into its hunk ranges. Returns [] when the
 * input is null, empty, or contains no parseable headers (e.g. GitHub omits
 * `patch` for binary files; same handling).
 */
export function parseHunkRanges(patch: string | null): HunkRange[] {
  if (patch === null || patch.length === 0) return [];
  const ranges: HunkRange[] = [];
  for (const line of patch.split("\n")) {
    const match = HUNK_HEADER.exec(line);
    if (match === null) continue;
    const newStart = Number.parseInt(match[1] ?? "0", 10);
    const newCount = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    if (newStart <= 0) continue;
    // A hunk with newCount=0 means deletion-only on the new side — the
    // suggestion block cannot target a line that no longer exists, so the
    // hunk contributes no targetable range.
    if (newCount === 0) continue;
    const start = newStart;
    const end = newStart + newCount - 1;
    ranges.push({ start, end });
  }
  return ranges;
}

/**
 * Returns true iff the inclusive range [startLine, endLine] lies fully inside
 * at least one hunk. Both endpoints must fall inside the same hunk — a range
 * that straddles two hunks isn't targetable by a single suggestion block.
 *
 * `startLine` and `endLine` come from Finding.evidence[].startLine/endLine.
 * A null startLine means the reviewer flagged the file without a specific
 * line; suggestion blocks REQUIRE a specific anchor, so null fails the check.
 */
export function rangeFallsInsideHunk(
  ranges: readonly HunkRange[],
  startLine: number | null,
  endLine: number | null,
): boolean {
  if (startLine === null || startLine <= 0) return false;
  // A null endLine = a single-line finding; treat it as startLine.
  const lo = startLine;
  const hi = endLine === null || endLine < startLine ? startLine : endLine;
  for (const range of ranges) {
    if (lo >= range.start && hi <= range.end) return true;
  }
  return false;
}

/**
 * Count the added/changed lines in a proposed patch. Used for the 20-line
 * size cap. Counts lines that start with "+" in the patch body but excludes
 * the "+++ b/path" file header. Lines that are pure deletions ("-") and
 * context lines (" ") don't count.
 *
 * We count adds (not adds+removes) because a suggestion block's
 * visible cost to the reviewer is the size of the replacement, not the
 * size of the diff.
 */
export function countAddedLines(patch: string): number {
  let count = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) continue;
    if (line.startsWith("+")) count += 1;
  }
  return count;
}
