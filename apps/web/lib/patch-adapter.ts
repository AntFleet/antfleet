// Patch adapter — normalises a stored `suggested_patch` into a form that
// `git apply --index` can consume.
//
// The model that produces these patches is asked for a unified diff, but
// observed bench data shows two recurring shape defects:
//   1. Missing `diff --git a/<path> b/<path>` header. Some git versions
//      tolerate this; others reject the patch as malformed.
//   2. Malformed hunk header — `@@` with no `-X,N +A,M @@` line counts, or
//      counts that disagree with the actual `-`/`+` line tally. `git apply`
//      rejects both shapes ("corrupt patch at line N").
//
// We can't trust the model's hunk numbers. So the adapter ignores them
// entirely: it lifts the patch's old-side and new-side content, finds
// where the old-side block actually lives in the file at HEAD (whitespace-
// tolerant match), and emits a fresh hunk header anchored on that
// location. The fix the model proposed is preserved verbatim; only the
// envelope is rebuilt.
//
// If the patch is already well-formed (has `diff --git` plus matching
// hunk counts), we pass it through unchanged. If the old-side block
// cannot be located in the file, we return `null` and let the caller
// treat the patch as un-applicable.

import { normalizeForCompare } from "./patch-acceptance";

export type AdaptResult =
  | { ok: true; patch: string; adapted: boolean }
  | { ok: false; reason: string };

export function normalizePatchForApply(args: {
  patch: string;
  evidencePath: string;
  fileContents: string;
}): AdaptResult {
  const parsed = parseUnifiedDiff(args.patch);
  if (parsed === null) {
    return { ok: false, reason: "patch did not contain --- / +++ headers" };
  }
  // Trust the patch's stated path only when it matches the evidence path
  // we have from the finding. Disagreement is a strong signal the patch
  // doesn't belong to this finding; refuse rather than apply to the wrong
  // file. The leading "a/" / "b/" prefixes are stripped before compare.
  const patchPath = stripPathPrefix(parsed.path);
  const evidencePath = stripPathPrefix(args.evidencePath);
  if (patchPath !== evidencePath) {
    return {
      ok: false,
      reason: `patch path (${patchPath}) does not match evidence path (${evidencePath})`,
    };
  }
  if (parsed.oldLines.length === 0 && parsed.newLines.length === 0) {
    return { ok: false, reason: "patch had no - or + lines" };
  }
  // If the patch is already well-formed AND the hunk header counts are
  // self-consistent with the - and + tallies, AND it carries the
  // `diff --git` header, pass through unchanged. Anything else gets
  // rebuilt.
  const alreadyClean =
    parsed.hasDiffHeader &&
    parsed.hunkCountsMatch === true &&
    parsed.hunkStart !== null &&
    parsed.parseError === null;
  if (alreadyClean) {
    return { ok: true, patch: args.patch, adapted: false };
  }

  const anchor = locateAnchor(args.fileContents, parsed.oldLines);
  if (anchor === null) {
    return {
      ok: false,
      reason: "could not locate the patch's old-side block inside the evidence file",
    };
  }

  const rebuilt = renderUnifiedDiff({
    path: evidencePath,
    anchorLine: anchor,
    oldLines: parsed.oldLines,
    newLines: parsed.newLines,
  });
  return { ok: true, patch: rebuilt, adapted: true };
}

type ParsedDiff = {
  path: string;
  oldLines: string[];
  newLines: string[];
  hasDiffHeader: boolean;
  hunkStart: number | null;
  hunkCountsMatch: boolean | null;
  parseError: string | null;
};

// Loose-but-defensive parser. Walks the input line-by-line and pulls
// out:
//   - the path from the first `--- ` line (stripping "a/" prefix)
//   - the OLD-side content (every line starting with `-` except the
//     `--- a/path` header)
//   - the NEW-side content (every line starting with `+` except the
//     `+++ b/path` header)
//   - whether a `diff --git` header was present
//   - whether the @@ hunk-header counts match the actual - and + tallies
// We deliberately tolerate broken hunk headers; we'll rebuild them.
function parseUnifiedDiff(text: string): ParsedDiff | null {
  const lines = text.split("\n");
  let path: string | null = null;
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let hasDiffHeader = false;
  let hunkStart: number | null = null;
  let statedOldCount: number | null = null;
  let statedNewCount: number | null = null;
  let parseError: string | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      hasDiffHeader = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      const candidate = line.slice(4).trim();
      if (candidate !== "/dev/null" && path === null) path = candidate;
      continue;
    }
    if (line.startsWith("+++ ")) {
      // confirm path symmetry; if --- was missing we still use +++.
      if (path === null) path = line.slice(4).trim();
      continue;
    }
    if (line.startsWith("@@")) {
      const m = /^@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@/u.exec(line);
      if (m === null) {
        parseError = "malformed @@ hunk header";
        continue;
      }
      hunkStart = Number(m[1]);
      statedOldCount = m[2] !== undefined ? Number(m[2]) : 1;
      statedNewCount = m[4] !== undefined ? Number(m[4]) : 1;
      continue;
    }
    if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith("+")) {
      newLines.push(line.slice(1));
      continue;
    }
    // Context line ` ...`. We don't preserve context — the rebuilt diff
    // omits context lines and lets the anchor + - / + content carry the
    // location signal. This is acceptable because we recompute the anchor
    // against the file at HEAD; context lines are advisory in unified
    // diff anyway.
  }

  if (path === null) return null;

  const hunkCountsMatch =
    statedOldCount === null
      ? null
      : statedOldCount === oldLines.length && statedNewCount === newLines.length;

  return {
    path,
    oldLines,
    newLines,
    hasDiffHeader,
    hunkStart,
    hunkCountsMatch,
    parseError,
  };
}

// Whitespace-tolerant search for `oldLines` as a contiguous block inside
// `fileContents`. Returns the 1-based start line of the first match, or
// null when no match exists.
//
// Whitespace tolerance keeps us robust against the model occasionally
// indenting the suggestion slightly differently than the file does
// (tabs vs spaces, leading-whitespace drift). The matcher is
// patch-acceptance's `normalizeForCompare` so the heuristic is exactly
// the one we already use for patch-shipped detection.
export function locateAnchor(fileContents: string, oldLines: string[]): number | null {
  // Pure-add suggestions have no old-side block to match. They CAN'T be
  // anchored unambiguously without context lines; refuse rather than
  // applying to a guessed location. The caller treats null as "skip
  // verifier — leave the patch as inconclusive at the worker layer".
  if (oldLines.length === 0) return null;
  const oldNorm = oldLines.map(normalizeForCompare).filter((l) => l.length > 0);
  if (oldNorm.length === 0) return null;

  const fileLines = fileContents.split("\n");
  const fileNorm = fileLines.map(normalizeForCompare);

  for (let i = 0; i + oldNorm.length <= fileLines.length; i++) {
    // Walk a window of size oldNorm.length, advancing a pointer into
    // oldNorm as we skip blank-or-comment-stripped file lines whose
    // normalized form is empty.
    let oi = 0;
    let fi = i;
    while (fi < fileLines.length && oi < oldNorm.length) {
      const f = fileNorm[fi]!;
      if (f.length === 0) {
        fi++;
        continue;
      }
      if (f === oldNorm[oi]) {
        fi++;
        oi++;
        continue;
      }
      break;
    }
    if (oi === oldNorm.length) {
      // 1-based line number — unified diff uses 1-based indexing.
      return i + 1;
    }
  }
  return null;
}

function renderUnifiedDiff(args: {
  path: string;
  anchorLine: number;
  oldLines: string[];
  newLines: string[];
}): string {
  const path = args.path;
  const oldCount = args.oldLines.length;
  const newCount = args.newLines.length;
  // For pure-add hunks (oldCount === 0) the unified-diff convention is
  // `-0,0`; for pure-delete (newCount === 0) the new-side is `-anchor,0`.
  // Both edge cases are routed through this same renderer; the only
  // adjustment is the printed start line being `0` when the count is 0.
  const oldStart = oldCount === 0 ? 0 : args.anchorLine;
  const newStart = newCount === 0 ? 0 : args.anchorLine;
  const out: string[] = [];
  out.push(`diff --git a/${path} b/${path}`);
  out.push(`--- a/${path}`);
  out.push(`+++ b/${path}`);
  out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
  for (const l of args.oldLines) out.push(`-${l}`);
  for (const l of args.newLines) out.push(`+${l}`);
  // Trailing newline so `git apply` doesn't complain about a missing EOL.
  return out.join("\n") + "\n";
}

function stripPathPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}
