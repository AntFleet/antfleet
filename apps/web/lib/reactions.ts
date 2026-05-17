import type { NewMaintainerReaction } from "../db/schema";
import { getInstallationOctokit } from "./github-app";

// Mission 3 slice 3-4 — reaction polling primitives. AGENTS.md §10 names
// maintainer reactions as the most valuable signal in the system: what did
// the human do once an AntFleet comment landed on their PR? The cron loop in
// slice 3-5 walks every posted comment at 24h / 7d / 30d after PR open,
// converts each fresh reaction into a row in maintainer_reactions, and that
// stream is the substrate for the data flywheel (§7).
//
// This module ships only primitives — fetch + pure mapper. No orchestration,
// no DB writes; slice 3-5 composes them. Same split as sweeper.ts.

// The full GitHub reactions content enum. Listed verbatim from the v3 REST
// docs so a future API addition surfaces as a TS error rather than a silent
// "unknown" row.
export type GitHubReactionContent =
  | "+1"
  | "-1"
  | "laugh"
  | "confused"
  | "heart"
  | "hooray"
  | "rocket"
  | "eyes";

export type RawReaction = {
  content: GitHubReactionContent;
  // ISO 8601 string from GitHub. Parsed into a Date in the mapper.
  created_at: string;
  user?: { login?: string } | null;
};

// Normalized action_taken namespace. Prefixing with "reaction:" keeps the
// column distinguishable from future action sources (literal closes,
// /antfleet ack commands, comment-thread replies) without losing the raw
// signal. Reverse-mapping is trivial for aggregate analysis.
const CONTENT_TO_ACTION: Record<GitHubReactionContent, string> = {
  "+1": "reaction:thumbs_up",
  "-1": "reaction:thumbs_down",
  laugh: "reaction:laugh",
  confused: "reaction:confused",
  heart: "reaction:heart",
  hooray: "reaction:hooray",
  rocket: "reaction:rocket",
  eyes: "reaction:eyes",
};

/**
 * Pure mapper. Builds the rows we'd insert into maintainer_reactions for a
 * single (review, finding) pair from a list of raw GitHub reactions on the
 * comment that flagged that finding. Re-polling is the expected steady state
 * (GitHub returns the full list each call) — dedup is enforced at insert via
 * the unique constraint on (review_id, finding_id, reaction_at, action_taken).
 */
export function mapToMaintainerReactions(args: {
  reviewId: string;
  findingId: string;
  rawReactions: readonly RawReaction[];
}): NewMaintainerReaction[] {
  return args.rawReactions.map((r) => ({
    reviewId: args.reviewId,
    findingId: args.findingId,
    actionTaken: CONTENT_TO_ACTION[r.content],
    reactionAt: new Date(r.created_at),
    maintainerComment: null,
  }));
}

// Narrow Octokit surface — keeps unit tests structurally typed without
// re-implementing RestEndpointMethods. Same pattern as github-files.ts and
// sweeper.ts.
export type ReactionsOctokitMinimal = {
  rest: {
    reactions: {
      listForIssueComment: (params: {
        owner: string;
        repo: string;
        comment_id: number;
        per_page?: number;
      }) => Promise<{ data: RawReaction[] }>;
    };
  };
};

/**
 * Wire fetcher. Returns the full reaction list on one issue comment. We cap
 * per_page at 100 (GitHub's max) — a single PR-review comment shouldn't see
 * more reactions than that; revisit if real-repo data shows truncation.
 *
 * Errors propagate so the slice 3-5 cron handler can log per-finding and
 * keep iterating across the rest of the batch.
 */
export async function pollReactionsWith(
  octokit: ReactionsOctokitMinimal,
  args: { owner: string; repo: string; commentId: number },
): Promise<RawReaction[]> {
  const resp = await octokit.rest.reactions.listForIssueComment({
    owner: args.owner,
    repo: args.repo,
    comment_id: args.commentId,
    per_page: 100,
  });
  return resp.data;
}

export async function pollReactions(args: {
  installationId: number;
  owner: string;
  repo: string;
  commentId: number;
}): Promise<RawReaction[]> {
  const octokit = await getInstallationOctokit(args.installationId);
  return pollReactionsWith(octokit, args);
}
