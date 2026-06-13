import { hunksTouching } from "./diff-hunks";
import { getInstallationOctokit } from "./github-app";
import { messageOf } from "./log";

// Mission 3 slice 2 — closure detection. T3.3 (Option B) tightened this:
// a finding is "closed" when (a) its evidence file's diff between
// `review.commit_sha` and the current default-branch HEAD contains at
// least one hunk whose OLD-side range overlaps the finding's evidence
// line range, OR (b) line range is unavailable / the patch is missing
// (binary file, oversized diff) — in which case we fall back to the
// pre-T3.3 file-changed signal so legacy rows without line data still
// degrade gracefully and binary-file truncation is never silently
// treated as "still_open".
//
// V2/V3 noise analysis says agreed findings are ~100% real, so even the
// file-changed fallback is a strong proxy for "the bug got addressed."
// False positives (an unrelated edit elsewhere in the file) used to be
// the dominant failure mode; the hunk-overlap check eliminates them for
// findings that carry a line range, which is the modern path.
//
// We do not re-run the review on main (slice 3-2 Option B); a missed close
// is corrected the next time a PR fires and the file is reviewed again.

export type FindingForClosureCheck = {
  findingId: string;
  evidencePath: string;
  // Inclusive line range against `review.commit_sha` (the OLD side of the
  // compareCommits diff). Null on legacy rows where the evidence didn't
  // carry numeric line data — those fall back to the file-changed signal.
  startLine: number | null;
  endLine: number | null;
};

// Minimal shape of a single file entry from `repos.compareCommits`. `patch`
// is omitted by GitHub for binary files and oversized diffs (>300 files or
// >20k additions) — that omission triggers the file-changed fallback rather
// than being silently treated as "no overlap".
export type ChangedFile = {
  filename: string;
  patch?: string;
};

export type ClosureDecision =
  | { findingId: string; status: "closed"; closureSha: string }
  | { findingId: string; status: "still_open" }
  | { findingId: string; status: "indeterminate"; reason: string };

/**
 * Pure decision function. For each finding:
 *   - if the finding's file is not in the changed set → still_open;
 *   - if the file is changed and the finding has a line range AND the
 *     entry has a `patch` → mark closed only when at least one hunk
 *     overlaps the finding range;
 *   - if the file is changed but line range is null OR patch is absent
 *     (binary file / oversized diff) → fall back to file-changed (closed).
 *
 * The closure SHA is pinned to `currentMainSha` (HEAD at sweep time).
 * Identifying the specific intermediate commit that touched the matching
 * hunk would require a second compareCommits-per-commit round-trip — see
 * the TODO at the close site. The current SHA still resolves to a real
 * commit on the default branch and is the same SHA the reviewer would
 * recompute against if re-run today.
 */
export function classifyFindings(args: {
  reviewCommitSha: string;
  currentMainSha: string;
  changedFiles: readonly ChangedFile[];
  findings: readonly FindingForClosureCheck[];
}): ClosureDecision[] {
  // No divergence — the base of the review is still the current HEAD. Nothing
  // could have closed yet.
  if (args.currentMainSha === args.reviewCommitSha) {
    return args.findings.map((f) => ({ findingId: f.findingId, status: "still_open" as const }));
  }
  // Pre-index changed files by filename so per-finding lookup is O(1).
  // We keep the first occurrence's patch — `compareCommits` lists each
  // path once per response.
  const byPath = new Map<string, ChangedFile>();
  for (const cf of args.changedFiles) {
    if (!byPath.has(cf.filename)) byPath.set(cf.filename, cf);
  }
  return args.findings.map((f) => {
    const cf = byPath.get(f.evidencePath);
    if (cf === undefined) {
      return { findingId: f.findingId, status: "still_open" as const };
    }
    // File was touched. Decide whether the touch overlapped the finding.
    // Both endpoints must be non-null to run the tightest check — a half-
    // populated range (e.g. legacy row with startLine but not endLine)
    // degrades to the file-changed signal rather than risking a wrong
    // overlap call against synthetic data.
    const { startLine, endLine } = f;
    const patch = cf.patch;
    if (startLine !== null && endLine !== null && typeof patch === "string" && patch.length > 0) {
      // Tightest path — hunk-overlap check. Closed only when a hunk on
      // the OLD side intersects the finding range.
      const touched = hunksTouching(patch, { start: startLine, end: endLine });
      if (!touched) {
        return { findingId: f.findingId, status: "still_open" as const };
      }
    }
    // Either:
    //   - we have a hunk-overlap match, OR
    //   - line range is null (legacy row), OR
    //   - patch is missing (binary file / oversized-diff truncation).
    // In the latter two cases we fall back to the pre-T3.3 file-changed
    // signal rather than silently dropping the close.
    return {
      findingId: f.findingId,
      status: "closed" as const,
      // TODO(T3.3 nice-to-have): identify the specific commit in
      // [reviewCommitSha..currentMainSha] that contains the matching
      // hunk and pin its SHA instead of HEAD. compareCommits returns
      // the commit list but not per-commit per-file patches; a precise
      // pin needs per-commit getCommit calls. Acceptable for now —
      // currentMainSha is the SHA the receipt would resolve against
      // today, and it's a real commit on the default branch.
      closureSha: args.currentMainSha,
    };
  });
}

// Narrow Octokit surface — keeps unit tests structurally typed without re-
// implementing RestEndpointMethods. Same pattern as github-files.ts.
export type SweeperOctokitMinimal = {
  rest: {
    git: {
      getRef: (params: { owner: string; repo: string; ref: string }) => Promise<{
        data: { object: { sha: string } };
      }>;
    };
    repos: {
      compareCommits: (params: {
        owner: string;
        repo: string;
        base: string;
        head: string;
      }) => Promise<{
        // `patch` is the unified-diff fragment for the file. GitHub
        // omits it for binary files and oversized diffs (>300 files or
        // >20k additions across the comparison) — those entries fall
        // back to the file-changed signal inside classifyFindings.
        data: { files?: Array<{ filename: string; patch?: string }> };
      }>;
    };
  };
};

/**
 * Wire detector. Fetches the current default-branch SHA, compares it against
 * the review's commit SHA, and routes the file diff into classifyFindings.
 *
 * Returns one ClosureDecision per input finding. Network/API failure surfaces
 * as `indeterminate` (not thrown) so a sweeper iteration can keep working
 * across other repos/findings even if one repo is unreachable.
 */
export async function detectClosuresWith(
  octokit: SweeperOctokitMinimal,
  args: {
    owner: string;
    repo: string;
    reviewCommitSha: string;
    findings: readonly FindingForClosureCheck[];
    baseBranch?: string;
  },
): Promise<ClosureDecision[]> {
  if (args.findings.length === 0) return [];
  const baseBranch = args.baseBranch ?? "main";

  let currentMainSha: string;
  try {
    const ref = await octokit.rest.git.getRef({
      owner: args.owner,
      repo: args.repo,
      ref: `heads/${baseBranch}`,
    });
    currentMainSha = ref.data.object.sha;
  } catch (err) {
    const message = messageOf(err);
    return args.findings.map((f) => ({
      findingId: f.findingId,
      status: "indeterminate" as const,
      reason: `${baseBranch} ref unavailable: ${message}`,
    }));
  }

  if (currentMainSha === args.reviewCommitSha) {
    return args.findings.map((f) => ({ findingId: f.findingId, status: "still_open" as const }));
  }

  let changedFiles: ChangedFile[];
  try {
    const compare = await octokit.rest.repos.compareCommits({
      owner: args.owner,
      repo: args.repo,
      base: args.reviewCommitSha,
      head: currentMainSha,
    });
    // Preserve the `patch` field — classifyFindings uses it for the
    // hunk-overlap check, and falls back to file-changed when absent.
    changedFiles = compare.data.files?.map((f) => ({ filename: f.filename, patch: f.patch })) ?? [];
  } catch (err) {
    const message = messageOf(err);
    return args.findings.map((f) => ({
      findingId: f.findingId,
      status: "indeterminate" as const,
      reason: `compareCommits failed: ${message}`,
    }));
  }

  return classifyFindings({
    reviewCommitSha: args.reviewCommitSha,
    currentMainSha,
    changedFiles,
    findings: args.findings,
  });
}

/**
 * Top-level entry — fetches an installation token, builds an Octokit, runs
 * detectClosuresWith. Pure-fn boundary is split for testability.
 */
export async function detectClosures(args: {
  installationId: number;
  owner: string;
  repo: string;
  reviewCommitSha: string;
  findings: readonly FindingForClosureCheck[];
  baseBranch?: string;
}): Promise<ClosureDecision[]> {
  const octokit = await getInstallationOctokit(args.installationId);
  return detectClosuresWith(octokit, args);
}
