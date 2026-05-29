import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import { logInfo, logWarn } from "./log";

// Absorbed-inline closure detection — LLM-judged diff equivalence.
//
// When an outgoing PR is closed without merge, the fix might still have
// landed via a separate upstream commit (the maintainer applied the same
// fix independently). This module detects that pattern by comparing the
// PR's diff against recent commits on the base branch.
//
// False-positive guard: when in doubt, return absorbed=false. A missed
// absorption is a false negative that under-counts receipts; a false
// positive would claim credit for a fix that wasn't ours — much worse.

const JUDGE_MODEL = "claude-opus-4-7";
const JUDGE_MAX_TOKENS = 512;
const CONFIDENCE_THRESHOLD = 0.7;
// Raised from 20 to 100 after PR #8 verification gap: repos with heavy
// automated commit noise (e.g. autonomopoly's cron-failure loop produces
// ~5 commits/hour) push human/maintainer commits past a 20-deep window
// within a day. The file-overlap pre-filter keeps LLM cost bounded —
// only commits touching the same files as the PR get judged.
const MAX_CANDIDATE_COMMITS = 100;
// Diff size caps to avoid blowing up the LLM context window and cost.
const MAX_PR_DIFF_CHARS = 30_000;
const MAX_COMMIT_DIFF_CHARS = 30_000;

const ANTHROPIC_CLIENT_OPTS = {
  defaultHeaders: { "anthropic-beta": "prompt-caching-2024-07-31" },
} as const;

export type AbsorbedInlineResult =
  | {
      absorbed: true;
      commitSha: string;
      confidence: number;
      reasoning: string;
      commitMessage: string;
    }
  | { absorbed: false };

type JudgeOutput = {
  equivalent: boolean;
  confidence: number;
  reasoning: string;
};

const JUDGE_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    equivalent: {
      type: "boolean" as const,
      description:
        "True if this commit applied the same fix as the PR. Bundled adjacent work is OK — the fix must be present, not the only change.",
    },
    confidence: {
      type: "number" as const,
      description: "Confidence score 0.0 to 1.0.",
    },
    reasoning: {
      type: "string" as const,
      description:
        "Brief explanation of why this commit does or does not apply the same fix. Max 200 characters.",
    },
  },
  required: ["equivalent", "confidence", "reasoning"] as const,
  additionalProperties: false,
};

export type AbsorbedInlineDeps = {
  getPrDiff: (args: { owner: string; repo: string; pullNumber: number }) => Promise<string>;
  listRecentCommits: (args: {
    owner: string;
    repo: string;
    since: string; // ISO 8601
  }) => Promise<Array<{ sha: string; message: string; date: string }>>;
  getCommitDiff: (args: { owner: string; repo: string; sha: string }) => Promise<string>;
  getCommitFiles: (args: { owner: string; repo: string; sha: string }) => Promise<string[]>;
  judgeEquivalence: (args: {
    prTitle: string;
    prDiff: string;
    commitMessage: string;
    commitDiff: string;
  }) => Promise<JudgeOutput>;
};

// Extract file paths from a unified diff. Used for the cheap file-overlap
// pre-filter that avoids LLM calls on obviously unrelated commits.
export function extractDiffFilePaths(diff: string): Set<string> {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    if (line === "--- /dev/null" || line === "+++ /dev/null") continue;
    if (line.startsWith("+++ b/") || line.startsWith("--- a/")) {
      paths.add(line.slice(6));
    }
  }
  return paths;
}

// Default time budget for a single detection run. The cron tick shares
// 180s across sweep + onboarder + outgoing polls; 60s per PR keeps
// headroom for 2-3 PRs closing simultaneously.
const DEFAULT_MAX_MS = 60_000;

export async function detectAbsorbedInline(
  pr: {
    upstreamOwner: string;
    upstreamRepo: string;
    upstreamPrNumber: number;
    openedAt: Date;
    branchOnFork: string;
  },
  deps: AbsorbedInlineDeps,
  opts: { maxMs?: number } = {},
): Promise<AbsorbedInlineResult> {
  const deadline = Date.now() + (opts.maxMs ?? DEFAULT_MAX_MS);
  // Step 1: Fetch the PR diff
  let prDiff: string;
  try {
    prDiff = await deps.getPrDiff({
      owner: pr.upstreamOwner,
      repo: pr.upstreamRepo,
      pullNumber: pr.upstreamPrNumber,
    });
  } catch (err) {
    logWarn("absorbed_inline.pr_diff_failed", {
      pr: `${pr.upstreamOwner}/${pr.upstreamRepo}#${pr.upstreamPrNumber}`,
      message: err instanceof Error ? err.message : String(err),
    });
    return { absorbed: false };
  }

  if (prDiff.length === 0) {
    return { absorbed: false };
  }

  // Truncate oversized diffs
  if (prDiff.length > MAX_PR_DIFF_CHARS) {
    prDiff = prDiff.slice(0, MAX_PR_DIFF_CHARS) + "\n... [truncated]";
  }

  const prFiles = extractDiffFilePaths(prDiff);
  if (prFiles.size === 0) {
    return { absorbed: false };
  }

  // Step 2: Fetch candidate commits since the PR was opened
  const candidates = await deps.listRecentCommits({
    owner: pr.upstreamOwner,
    repo: pr.upstreamRepo,
    since: pr.openedAt.toISOString(),
  });

  // Cap to most recent N
  const capped = candidates.slice(0, MAX_CANDIDATE_COMMITS);

  if (capped.length === 0) {
    return { absorbed: false };
  }

  // Step 3: Pre-filter by file overlap
  type ScoredCandidate = {
    sha: string;
    message: string;
    diff: string;
  };
  const filtered: ScoredCandidate[] = [];

  for (const candidate of capped) {
    try {
      const commitFiles = await deps.getCommitFiles({
        owner: pr.upstreamOwner,
        repo: pr.upstreamRepo,
        sha: candidate.sha,
      });
      const hasOverlap = commitFiles.some((f) => prFiles.has(f));
      if (!hasOverlap) continue;

      let commitDiff = await deps.getCommitDiff({
        owner: pr.upstreamOwner,
        repo: pr.upstreamRepo,
        sha: candidate.sha,
      });
      if (commitDiff.length > MAX_COMMIT_DIFF_CHARS) {
        commitDiff = commitDiff.slice(0, MAX_COMMIT_DIFF_CHARS) + "\n... [truncated]";
      }
      filtered.push({ sha: candidate.sha, message: candidate.message, diff: commitDiff });
    } catch (err) {
      logWarn("absorbed_inline.candidate_fetch_failed", {
        sha: candidate.sha,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (filtered.length === 0) {
    return { absorbed: false };
  }

  // Step 4: LLM-judge each filtered candidate
  // Extract a title from the PR's fork branch name as a fallback
  const prTitle = pr.branchOnFork.split(":").pop()?.replace(/[-_]/g, " ") ?? "";

  let bestMatch: { sha: string; confidence: number; reasoning: string; message: string } | null =
    null;

  for (const candidate of filtered) {
    if (Date.now() >= deadline) {
      logWarn("absorbed_inline.time_budget_exhausted", {
        pr: `${pr.upstreamOwner}/${pr.upstreamRepo}#${pr.upstreamPrNumber}`,
        candidatesRemaining: filtered.length - filtered.indexOf(candidate),
      });
      break;
    }
    try {
      const result = await deps.judgeEquivalence({
        prTitle,
        prDiff,
        commitMessage: candidate.message,
        commitDiff: candidate.diff,
      });

      logInfo("absorbed_inline.judge_result", {
        sha: candidate.sha.slice(0, 7),
        equivalent: result.equivalent,
        confidence: result.confidence,
        reasoning: result.reasoning.slice(0, 100),
      });

      if (
        result.equivalent &&
        result.confidence >= CONFIDENCE_THRESHOLD &&
        (bestMatch === null || result.confidence > bestMatch.confidence)
      ) {
        bestMatch = {
          sha: candidate.sha,
          confidence: result.confidence,
          reasoning: result.reasoning,
          message: candidate.message,
        };
      }
    } catch (err) {
      logWarn("absorbed_inline.judge_failed", {
        sha: candidate.sha.slice(0, 7),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (bestMatch === null) {
    return { absorbed: false };
  }

  return {
    absorbed: true,
    commitSha: bestMatch.sha,
    confidence: bestMatch.confidence,
    reasoning: bestMatch.reasoning,
    commitMessage: bestMatch.message,
  };
}

// ─── Real deps wiring ──────────────────────────────────────────────────────

function getAntfleetOpsToken(): string {
  const token = process.env["ANTFLEET_OPS_GH_TOKEN"];
  if (token === undefined || token.length === 0) {
    throw new Error("ANTFLEET_OPS_GH_TOKEN is required for absorbed-inline detection");
  }
  return token;
}

function parseJudgeOutput(raw: unknown): JudgeOutput {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("JUDGE_BAD_RESPONSE: output is not an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.equivalent !== "boolean") {
    throw new Error("JUDGE_BAD_RESPONSE: equivalent is not boolean");
  }
  if (typeof obj.confidence !== "number") {
    throw new Error("JUDGE_BAD_RESPONSE: confidence is not a number");
  }
  if (typeof obj.reasoning !== "string") {
    throw new Error("JUDGE_BAD_RESPONSE: reasoning is not a string");
  }
  return {
    equivalent: obj.equivalent,
    confidence: Math.max(0, Math.min(1, obj.confidence)),
    reasoning: obj.reasoning.slice(0, 500),
  };
}

export function realAbsorbedInlineDeps(): AbsorbedInlineDeps {
  const octokit = new Octokit({ auth: getAntfleetOpsToken() });

  return {
    getPrDiff: async ({ owner, repo, pullNumber }) => {
      const resp = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
        mediaType: { format: "diff" },
      });
      // When requesting diff format, Octokit returns the diff as a string
      // in resp.data, typed as unknown.
      return resp.data as unknown as string;
    },

    listRecentCommits: async ({ owner, repo, since }) => {
      const resp = await octokit.rest.repos.listCommits({
        owner,
        repo,
        since,
        per_page: MAX_CANDIDATE_COMMITS,
      });
      return resp.data.map((c) => ({
        sha: c.sha,
        message: c.commit.message,
        date: c.commit.committer?.date ?? c.commit.author?.date ?? "",
      }));
    },

    getCommitDiff: async ({ owner, repo, sha }) => {
      const resp = await octokit.rest.repos.getCommit({
        owner,
        repo,
        ref: sha,
        mediaType: { format: "diff" },
      });
      return resp.data as unknown as string;
    },

    getCommitFiles: async ({ owner, repo, sha }) => {
      const resp = await octokit.rest.repos.getCommit({
        owner,
        repo,
        ref: sha,
      });
      return (resp.data.files ?? []).map((f) => f.filename);
    },

    judgeEquivalence: async ({ prTitle, prDiff, commitMessage, commitDiff }) => {
      const apiKey = process.env["ANTHROPIC_API_KEY"];
      if (apiKey === undefined || apiKey.length === 0) {
        throw new Error("ANTHROPIC_API_KEY is required for absorbed-inline judge");
      }
      const client = new Anthropic({ apiKey, ...ANTHROPIC_CLIENT_OPTS });
      const response = await client.messages.create({
        model: JUDGE_MODEL,
        max_tokens: JUDGE_MAX_TOKENS,
        tools: [
          {
            name: "judge_equivalence",
            description:
              "Judge whether a commit applies the substantive fix from the PR. " +
              "Bundled adjacent work is OK; missing cosmetic/documentation parts " +
              "of the PR is also OK as long as the functional substance is present. " +
              "Pure coincidence on file paths is NOT a match.",
            input_schema: JUDGE_TOOL_SCHEMA as unknown as Anthropic.Messages.Tool["input_schema"],
          },
        ],
        tool_choice: { type: "tool", name: "judge_equivalence" },
        system:
          "You are AntFleet's absorbed-inline judge. Your job is to determine whether " +
          "a given upstream commit applies the same SUBSTANTIVE fix as a closed PR. " +
          "Criterion: the commit must apply the functional behavioral change from the PR — " +
          "the code that addresses the underlying bug, security issue, or correctness problem. " +
          "The commit MAY bundle additional unrelated work — that's fine. " +
          "The commit MAY also OMIT secondary parts of the PR like documentation edits, " +
          "comment corrections, formatting changes, or other cosmetic improvements — " +
          "that's also fine, as long as the functional substance is present. " +
          "Mere file-path overlap with semantically different changes is NOT a match. " +
          "Strong prior: if the commit message explicitly references the PR by number or " +
          "describes the same fix in equivalent terms, weight this highly — only override " +
          "if the diff clearly diverges from what the message claims. " +
          "Be conservative on the substance: when in doubt about whether the functional " +
          "change is present, say equivalent=false. But do NOT conflate 'missing cosmetic " +
          "part' with 'wrong fix' — partial absorption of the PR's substantive change is " +
          "still a match.",
        messages: [
          {
            role: "user",
            content:
              `PR title: ${prTitle}\n\n` +
              `=== PR DIFF ===\n${prDiff}\n\n` +
              `=== CANDIDATE COMMIT MESSAGE ===\n${commitMessage}\n\n` +
              `=== CANDIDATE COMMIT DIFF ===\n${commitDiff}`,
          },
        ],
      });

      for (const block of response.content) {
        if (block.type === "tool_use" && block.name === "judge_equivalence") {
          return parseJudgeOutput(block.input);
        }
      }
      throw new Error("JUDGE_BAD_RESPONSE: missing tool_use(judge_equivalence)");
    },
  };
}
