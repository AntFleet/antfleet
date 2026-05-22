// Patch Agent v1.5 — patch-acceptance detection.
//
// The sweeper's existing closure pass marks a finding closed when its
// evidence file is touched between the review commit and HEAD on the
// default branch (evidence-file-touch heuristic). That's coarse: any
// file change passes. The patch-acceptance pass is sharper — it only
// fires when the NEW-side content of the posted ```suggestion``` block
// is observed in the file at HEAD. That makes the acceptance signal an
// auditable "the maintainer actually adopted what we proposed", not
// "the maintainer touched the file".
//
// Both passes co-exist: a finding can close via the broader evidence-
// file path AND/OR via patch acceptance. The receipt comments are
// distinct so /receipts can show the difference.
//
// Matching is whitespace-tolerant. The model occasionally indents the
// suggestion slightly differently from how the codebase tabs/spaces.
// We collapse runs of whitespace and trim line-leading whitespace for
// the comparison; trailing whitespace and blank lines are ignored.

// Extract the new-side lines from a unified-diff patch. A line starting
// with "+" (other than the "+++ b/path" header) is a NEW-side line. The
// returned array preserves order; empty trailing lines are stripped.
export function extractNewSideLines(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    // Use the trailing-space variant for symmetry with diff-hunks.ts's
    // countAddedLines — `+++ b/path` always has the space, but a real
    // content line starting with `+++` (e.g. an MDX frontmatter delim)
    // should NOT be skipped.
    if (line.startsWith("+++ ")) continue;
    if (line.startsWith("+")) {
      out.push(line.slice(1));
    }
  }
  // Strip trailing blank lines — they're unstable artifacts of unified-diff
  // formatting and would otherwise force a false negative.
  while (out.length > 0 && (out[out.length - 1] ?? "").trim().length === 0) {
    out.pop();
  }
  return out;
}

// Defensive cap: the orchestrator enforces a 20-line size cap before
// persist, but `patchContentMatchesFile` is also called directly from
// the sweeper against DB content. A manual SQL backfill or future code
// path could bypass the orchestrator cap; this floor stops a runaway
// patch from blowing the n*m bound of the matcher.
const MATCH_NEW_LINE_HARD_CAP = 100;

// Whitespace-tolerant comparator. Two strings are equivalent if their
// whitespace-normalized forms match. Used to dodge tab-vs-spaces drift
// and indentation jitter between the model's suggestion and the file
// the maintainer actually committed.
export function normalizeForCompare(s: string): string {
  return s.replace(/\s+/gu, " ").trim();
}

/**
 * Returns true iff the new-side content of `patch` appears as a contiguous
 * sequence of lines somewhere in `fileContents` (whitespace-tolerant).
 *
 * The match doesn't require a specific line number — the diff hunk header
 * tells us where the patch WAS proposed; the file at HEAD may have shifted
 * lines from unrelated edits. We only care whether the suggested NEW-side
 * lines exist in the current file body.
 */
export function patchContentMatchesFile(patch: string, fileContents: string): boolean {
  const newLines = extractNewSideLines(patch).map(normalizeForCompare);
  // No additions = nothing to detect. Pure-deletion suggestions are not
  // representable as ```suggestion``` blocks anyway, so this is a safety
  // floor rather than a real codepath.
  if (newLines.length === 0) return false;
  // Defensive: refuse to match anything with more than the hard cap of
  // new-side lines. The orchestrator caps at 20 pre-persist; this is the
  // floor for the post-persist read path.
  if (newLines.length > MATCH_NEW_LINE_HARD_CAP) return false;
  // Skip pure-whitespace new lines from the search — they're useless as
  // anchors and would inflate false positives.
  const filtered = newLines.filter((l) => l.length > 0);
  if (filtered.length === 0) return false;

  const fileLines = fileContents.split("\n").map(normalizeForCompare);
  // Walk windows of size `filtered.length` and look for an exact normalized
  // match. Cheap O(n*m) but n*m is bounded by ~20 (cap) × file-length.
  for (let i = 0; i + filtered.length <= fileLines.length; i++) {
    let allMatch = true;
    for (let j = 0; j < filtered.length; j++) {
      if (fileLines[i + j] !== filtered[j]) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) return true;
  }
  return false;
}

/**
 * Patch Agent v1.6 — anchor-bound variant of patchContentMatchesFile.
 *
 * Requires the new-side content to appear at the exact anchor line
 * (1-based) the suggestion was posted on. Used by the click-apply
 * detection pass so an unrelated commit that incidentally adds matching
 * content elsewhere in the file cannot trigger a false-positive
 * `patch_apply_clicked` attribution. v1.5's whole-file scan stays for
 * the broader "the suggestion eventually shipped" signal; this is the
 * narrower "the button was used at THIS line" signal.
 *
 * Returns true iff the normalized new-side lines exactly match the
 * file's lines starting at (anchorLine - 1).
 */
export function patchContentMatchesFileAtLine(
  patch: string,
  fileContents: string,
  anchorLine: number,
): boolean {
  if (anchorLine < 1) return false;
  const newLines = extractNewSideLines(patch).map(normalizeForCompare);
  if (newLines.length === 0) return false;
  if (newLines.length > MATCH_NEW_LINE_HARD_CAP) return false;
  const filtered = newLines.filter((l) => l.length > 0);
  if (filtered.length === 0) return false;

  const fileLines = fileContents.split("\n").map(normalizeForCompare);
  const startIdx = anchorLine - 1;
  if (startIdx + filtered.length > fileLines.length) return false;
  for (let j = 0; j < filtered.length; j++) {
    if (fileLines[startIdx + j] !== filtered[j]) return false;
  }
  return true;
}
