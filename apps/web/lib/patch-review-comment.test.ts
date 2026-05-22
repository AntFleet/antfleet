import { describe, expect, it, vi } from "vitest";
import {
  postPatchReviewComment,
  type MinimalOctokit,
  type PostPatchReviewCommentArgs,
} from "./patch-review-comment";

const NEW_LINE_PATCH = [
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -10,1 +10,1 @@",
  "-const x = 1;",
  "+const x = 2;",
  "",
].join("\n");

const PURE_DELETION_PATCH = [
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -10,1 +10,0 @@",
  "-const x = 1;",
  "",
].join("\n");

const baseArgs = (
  overrides: Partial<PostPatchReviewCommentArgs> = {},
): PostPatchReviewCommentArgs => ({
  installationId: 12345,
  owner: "AntFleet",
  repo: "aeon-bench",
  pullNumber: 42,
  commitId: "abc123def456",
  path: "src/foo.ts",
  line: 10,
  patch: { patch: NEW_LINE_PATCH, modelId: "claude-opus-4-7" },
  ...overrides,
});

function makeOctokit(opts: {
  resolved?: { id: number; html_url: string };
  rejected?: Error;
  delayMs?: number;
}): { mock: MinimalOctokit; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async () => {
    if (opts.delayMs !== undefined) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
    if (opts.rejected !== undefined) throw opts.rejected;
    return { data: opts.resolved ?? { id: 99, html_url: "https://example.test/c/99" } };
  });
  return {
    mock: { rest: { pulls: { createReviewComment: create } } },
    create,
  };
}

describe("postPatchReviewComment", () => {
  it("returns id + url on success and posts with commit_id + line anchor", async () => {
    const { mock, create } = makeOctokit({
      resolved: { id: 7777, html_url: "https://github.com/AntFleet/aeon-bench/pull/42#r7777" },
    });
    const result = await postPatchReviewComment(
      baseArgs({ octokitFactory: async () => mock }),
    );
    expect(result).toEqual({ id: 7777, url: "https://github.com/AntFleet/aeon-bench/pull/42#r7777" });
    expect(create).toHaveBeenCalledOnce();
    const call = create.mock.calls[0]?.[0];
    expect(call.owner).toBe("AntFleet");
    expect(call.repo).toBe("aeon-bench");
    expect(call.pull_number).toBe(42);
    expect(call.commit_id).toBe("abc123def456");
    expect(call.path).toBe("src/foo.ts");
    expect(call.line).toBe(10);
    expect(call.side).toBe("RIGHT");
    // suggestion fence + new-side line, single source of truth via renderSuggestionBlock
    expect(call.body).toContain("```suggestion");
    expect(call.body).toContain("const x = 2;");
    expect(call.body).toContain("```");
  });

  it("returns null when the patch is pure-deletion (no new-side lines)", async () => {
    const { mock, create } = makeOctokit({});
    const result = await postPatchReviewComment(
      baseArgs({
        patch: { patch: PURE_DELETION_PATCH, modelId: "claude-opus-4-7" },
        octokitFactory: async () => mock,
      }),
    );
    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("returns null when Octokit throws a 422 (invalid path) — does not propagate", async () => {
    const err = Object.assign(new Error("Invalid request"), { status: 422 });
    const { mock } = makeOctokit({ rejected: err });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await postPatchReviewComment(
      baseArgs({ octokitFactory: async () => mock }),
    );
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns null when Octokit throws a 404 (commit gone) — does not propagate", async () => {
    const err = Object.assign(new Error("Not Found"), { status: 404 });
    const { mock } = makeOctokit({ rejected: err });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await postPatchReviewComment(
      baseArgs({ octokitFactory: async () => mock }),
    );
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("times out after the configured timeoutMs and returns null", async () => {
    const { mock } = makeOctokit({ delayMs: 200 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await postPatchReviewComment(
      baseArgs({ octokitFactory: async () => mock, timeoutMs: 25 }),
    );
    expect(result).toBeNull();
    const warnCall = warn.mock.calls[0]?.[1] as { error: string } | undefined;
    expect(warnCall?.error).toMatch(/timed out after 25ms/);
    warn.mockRestore();
  });

  it("includes the body prefix above the suggestion fence when provided", async () => {
    const { mock, create } = makeOctokit({});
    await postPatchReviewComment(
      baseArgs({
        octokitFactory: async () => mock,
        bodyPrefix: "Custom prefix line",
      }),
    );
    const call = create.mock.calls[0]?.[0];
    const body = call.body as string;
    const prefixIdx = body.indexOf("Custom prefix line");
    const fenceIdx = body.indexOf("```suggestion");
    expect(prefixIdx).toBeGreaterThanOrEqual(0);
    expect(fenceIdx).toBeGreaterThan(prefixIdx);
  });

  it("falls back to a generic prefix when none provided (model id surfaced)", async () => {
    const { mock, create } = makeOctokit({});
    await postPatchReviewComment(baseArgs({ octokitFactory: async () => mock }));
    const call = create.mock.calls[0]?.[0];
    expect(call.body).toContain("claude-opus-4-7");
  });
});
