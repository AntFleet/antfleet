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

// T3.3 — shared shape for closure-overlap ranges. OLD-side line range a
// finding was authored against; see hunksTouching below.
export type LineRange = {
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
 * Returns true iff the inclusive range [startLine, endLine] overlaps at least
 * one hunk. This is looser than rangeFallsInsideHunk and is used only for
 * deciding whether Patch Agent should spend a provider call on a finding whose
 * reviewer evidence may cite a broader block/function than the changed lines.
 */
export function rangeOverlapsHunk(
  ranges: readonly HunkRange[],
  startLine: number | null,
  endLine: number | null,
): boolean {
  if (startLine === null || startLine <= 0) return false;
  const lo = startLine;
  const hi = endLine === null || endLine < startLine ? startLine : endLine;
  for (const range of ranges) {
    if (lo <= range.end && hi >= range.start) return true;
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

// T3.3 — Option B closure-overlap check (OLD-side hunk parser).
//
// The Patch Agent helpers above operate on NEW-side ranges because they
// must align with the PR head's line numbers when posting suggestions.
// The closure sweeper has the inverse question: a finding's evidence range
// was authored against `review.commit_sha` (the OLD side of the
// compareCommits diff between review SHA -> HEAD). So we test overlap
// against `[oldStart, oldStart + oldCount - 1]`.
//
// Kept separate from `parseHunkRanges` because (a) we only need a single
// boolean answer per file, (b) the semantic is different (NEW-side suggest
// vs OLD-side closure), and (c) it lets us reject pure-deletion hunks on
// the new side without affecting the closure check, where a deletion that
// removes the flagged lines absolutely counts as "touched".

// Same shape as HUNK_HEADER above but captures the OLD-side coordinates.
// Multi-line + global so it scans the full patch in one pass.
const HUNK_HEADER_OLD = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gmu;

/**
 * Returns true iff the patch contains at least one hunk whose OLD-side line
 * range overlaps the inclusive finding range [range.start, range.end].
 *
 * Overlap test (both inclusive):
 *   hunk old range  = [oldStart, oldStart + oldCount - 1]
 *   finding range   = [range.start, range.end]
 *   overlap iff hunk_end >= range.start && hunk_first <= range.end
 *
 * Edge cases:
 *   - Omitted oldCount defaults to 1 (e.g. "@@ -10 +12,3 @@").
 *   - oldCount === 0 means a pure insertion at line `oldStart` on the new
 *     side (nothing removed from old). The insertion lives BETWEEN old
 *     lines `oldStart` and `oldStart + 1`, but git renders it as anchored
 *     at `oldStart`. We treat the touched point as `oldStart` so that an
 *     insertion adjacent to the flagged range still registers as activity
 *     in the region — conservative (favors marking closed when in doubt).
 *   - An empty / null patch returns false (caller should fall back to the
 *     file-changed signal in that case; see classifyFindings).
 *   - range.start > range.end returns false (invalid input).
 */
export function hunksTouching(patch: string, range: LineRange): boolean {
  if (patch.length === 0) return false;
  if (range.start > range.end) return false;
  // Reset lastIndex — the regex has /g and lives at module scope; without
  // a reset, a previous call could leave it past the end of the next input.
  HUNK_HEADER_OLD.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HUNK_HEADER_OLD.exec(patch)) !== null) {
    const oldStart = Number.parseInt(match[1] ?? "0", 10);
    if (oldStart <= 0) continue;
    const oldCountRaw = match[2];
    const oldCount = oldCountRaw === undefined ? 1 : Number.parseInt(oldCountRaw, 10);
    const hunkFirst = oldStart;
    const hunkLast = oldCount === 0 ? oldStart : oldStart + oldCount - 1;
    if (hunkLast >= range.start && hunkFirst <= range.end) {
      return true;
    }
  }
  return false;
}
