import { getInstallationOctokit } from "./github-app";
import { messageOf } from "./log";

// Mission 3 slice 2 — closure detection. The heuristic is intentionally cheap:
// a finding is "closed" when its evidence file changed between
// `review.commit_sha` and the current default-branch HEAD. We don't re-run the
// review on main (slice 3-2 Option B); V2/V3 noise analysis says agreed
// findings are ~100% real, so "file got touched" is a strong proxy for
// "the bug got addressed." False positives are corrected the next time the
// next PR fires and the file is reviewed again.

export type FindingForClosureCheck = {
  findingId: string;
  evidencePath: string;
};

export type ClosureDecision =
  | { findingId: string; status: "closed"; closureSha: string }
  | { findingId: string; status: "still_open" }
  | { findingId: string; status: "indeterminate"; reason: string };

/**
 * Pure decision function. Given:
 *   - the SHA at which the review ran,
 *   - the current default-branch HEAD SHA,
 *   - the set of file paths that changed between them,
 *   - the list of open findings (with their evidence paths),
 * classify each finding as closed (its file was touched), still_open
 * (its file wasn't), or indeterminate (no signal).
 */
export function classifyFindings(args: {
  reviewCommitSha: string;
  currentMainSha: string;
  changedFiles: readonly string[];
  findings: readonly FindingForClosureCheck[];
}): ClosureDecision[] {
  // No divergence — the base of the review is still the current HEAD. Nothing
  // could have closed yet.
  if (args.currentMainSha === args.reviewCommitSha) {
    return args.findings.map((f) => ({ findingId: f.findingId, status: "still_open" as const }));
  }
  const changed = new Set(args.changedFiles);
  return args.findings.map((f) => {
    if (changed.has(f.evidencePath)) {
      return {
        findingId: f.findingId,
        status: "closed" as const,
        closureSha: args.currentMainSha,
      };
    }
    return { findingId: f.findingId, status: "still_open" as const };
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
      }) => Promise<{ data: { files?: Array<{ filename: string }> } }>;
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

  let changedFiles: string[];
  try {
    const compare = await octokit.rest.repos.compareCommits({
      owner: args.owner,
      repo: args.repo,
      base: args.reviewCommitSha,
      head: currentMainSha,
    });
    changedFiles = compare.data.files?.map((f) => f.filename) ?? [];
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
