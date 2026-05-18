import { describe, expect, it, vi } from "vitest";
import {
  type GitHubReactionContent,
  type RawReaction,
  mapToMaintainerReactions,
  pollReactionsWith,
} from "./reactions";

const reviewId = "11111111-2222-3333-4444-555555555555";
const findingId = "11111111-0";

function raw(content: GitHubReactionContent, createdAt: string): RawReaction {
  return { content, created_at: createdAt, user: { login: "octocat" } };
}

describe("mapToMaintainerReactions", () => {
  it("returns [] for an empty list", () => {
    expect(mapToMaintainerReactions({ reviewId, findingId, rawReactions: [] })).toEqual([]);
  });

  it("maps every GitHub reaction content variant to a namespaced action_taken", () => {
    const all: GitHubReactionContent[] = [
      "+1",
      "-1",
      "laugh",
      "confused",
      "heart",
      "hooray",
      "rocket",
      "eyes",
    ];
    const rows = mapToMaintainerReactions({
      reviewId,
      findingId,
      rawReactions: all.map((c) => raw(c, "2026-05-17T12:00:00Z")),
    });
    const actions = rows.map((r) => r.actionTaken);
    expect(actions).toEqual([
      "reaction:thumbs_up",
      "reaction:thumbs_down",
      "reaction:laugh",
      "reaction:confused",
      "reaction:heart",
      "reaction:hooray",
      "reaction:rocket",
      "reaction:eyes",
    ]);
  });

  it("stamps reaction_at from the raw created_at, parsed to a Date", () => {
    const rows = mapToMaintainerReactions({
      reviewId,
      findingId,
      rawReactions: [raw("+1", "2026-05-17T09:30:45Z")],
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.reactionAt).toBeInstanceOf(Date);
    expect((row.reactionAt as Date).toISOString()).toBe("2026-05-17T09:30:45.000Z");
  });

  it("propagates reviewId and findingId onto every row and leaves maintainerComment null", () => {
    const rows = mapToMaintainerReactions({
      reviewId,
      findingId,
      rawReactions: [raw("+1", "2026-05-17T09:30:45Z"), raw("rocket", "2026-05-17T09:31:00Z")],
    });
    for (const row of rows) {
      expect(row.reviewId).toBe(reviewId);
      expect(row.findingId).toBe(findingId);
      expect(row.maintainerComment).toBeNull();
    }
  });

  it("preserves order and produces stable dedup-key tuples", () => {
    // The unique index in 0002_lush_nighthawk.sql is
    // (review_id, finding_id, reaction_at, action_taken). Two reactions of
    // the same content posted at distinct seconds must produce distinct
    // dedup keys; same content at the same second must collide.
    const rows = mapToMaintainerReactions({
      reviewId,
      findingId,
      rawReactions: [
        raw("+1", "2026-05-17T09:30:45Z"),
        raw("+1", "2026-05-17T09:30:46Z"),
        raw("+1", "2026-05-17T09:30:45Z"),
      ],
    });
    const keys = rows.map(
      (r) =>
        `${r.reviewId}|${r.findingId}|${(r.reactionAt as Date).toISOString()}|${r.actionTaken}`,
    );
    // First and third are dedup-key identical; second is distinct.
    expect(keys[0]).toBe(keys[2]);
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe("pollReactionsWith", () => {
  const mkOctokit = (overrides: { reactions?: RawReaction[]; throws?: Error }) => ({
    rest: {
      reactions: {
        listForIssueComment: vi.fn().mockImplementation(async () => {
          if (overrides.throws) throw overrides.throws;
          return { data: overrides.reactions ?? [] };
        }),
      },
    },
  });

  it("returns the raw data array on success", async () => {
    const reactions = [raw("+1", "2026-05-17T09:30:45Z"), raw("rocket", "2026-05-17T09:31:00Z")];
    const octokit = mkOctokit({ reactions });
    const out = await pollReactionsWith(octokit, {
      owner: "o",
      repo: "r",
      commentId: 12345,
    });
    expect(out).toEqual(reactions);
    expect(octokit.rest.reactions.listForIssueComment).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      comment_id: 12345,
      per_page: 100,
    });
  });

  it("returns an empty array when the comment has no reactions", async () => {
    const octokit = mkOctokit({ reactions: [] });
    const out = await pollReactionsWith(octokit, {
      owner: "o",
      repo: "r",
      commentId: 12345,
    });
    expect(out).toEqual([]);
  });

  it("propagates Octokit errors so the slice 3-5 cron handler can log per-finding", async () => {
    const octokit = mkOctokit({ throws: new Error("404 Not Found") });
    await expect(
      pollReactionsWith(octokit, { owner: "o", repo: "r", commentId: 12345 }),
    ).rejects.toThrow("404 Not Found");
  });
});
