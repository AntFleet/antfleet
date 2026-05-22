import { getInstallationOctokit } from "./github-app";
import { renderSuggestionBlock, type PatchForRender } from "./pr-comment";

// Patch Agent v1.6 — PR review-comment poster. The review comment is the
// one place GitHub renders the "Commit suggestion" button on a ```suggestion
// fence. The v1.5 issue comment renders the same fence as informational
// text only (no button). v1.6 posts BOTH: the issue comment keeps the
// review summary + settlement footer, and per-finding review comments
// carry the apply-button payload.
//
// Failure to post the review comment is logged and returns null. The
// issue comment is the contract path: it must never be blocked by a
// review-comment failure (non-break invariant 2 in the spec).

const DEFAULT_TIMEOUT_MS = 30_000;

export type PostPatchReviewCommentArgs = {
  installationId: number;
  owner: string;
  repo: string;
  pullNumber: number;
  // The PR head SHA at the time of posting. GitHub requires commit_id
  // for line anchoring; if the PR advances we re-anchor on the next
  // review-worker run (no retroactive moves — forward-only per spec).
  commitId: string;
  // File path relative to repo root, matching the PR diff path.
  path: string;
  // 1-based new-side line number the suggestion replaces. v1.6 ships
  // single-line anchors only — multi-line evidence falls back to the
  // v1.5 issue-comment <details> path (locked operator decision Q2).
  line: number;
  // The patch text + model id; rendered into a ```suggestion fence
  // via the same renderSuggestionBlock the issue comment uses, so
  // there is one source of truth for the literal replacement text.
  patch: PatchForRender;
  // Body prefix shown above the suggestion fence; carries the finding
  // headline so a reader landing on the review comment alone still has
  // context. Optional — default is a short generic line.
  bodyPrefix?: string;
  // Optional injection seams. Default uses getInstallationOctokit; tests
  // pass a mock that throws / resolves / hangs to drive the timeout +
  // error paths.
  octokitFactory?: (installationId: number) => Promise<MinimalOctokit>;
  timeoutMs?: number;
};

export type PostPatchReviewCommentResult = {
  id: number;
  url: string;
};

// Narrow Octokit subset we depend on. Keeps the test seam minimal and
// avoids importing the heavy @octokit/rest type just for a mock.
export type MinimalOctokit = {
  rest: {
    pulls: {
      createReviewComment: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        commit_id: string;
        path: string;
        line: number;
        side?: "RIGHT" | "LEFT";
        body: string;
      }) => Promise<{ data: { id: number; html_url: string } }>;
    };
  };
};

export async function postPatchReviewComment(
  args: PostPatchReviewCommentArgs,
): Promise<PostPatchReviewCommentResult | null> {
  const block = renderSuggestionBlock(args.patch);
  if (block === null) {
    // Pure-deletion patches have no new-side content; v1.5 already
    // suppresses the suggestion block in this case. The review-comment
    // path follows the same rule.
    return null;
  }

  const prefix =
    args.bodyPrefix !== undefined && args.bodyPrefix.length > 0
      ? args.bodyPrefix
      : `**Proposed patch** (model: \`${args.patch.modelId}\`)`;
  const body = `${prefix}\n\n${block.join("\n")}`;

  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const octokitFactory = args.octokitFactory ?? getInstallationOctokit;

  try {
    const octokit = await octokitFactory(args.installationId);
    const resp = await withTimeout(
      octokit.rest.pulls.createReviewComment({
        owner: args.owner,
        repo: args.repo,
        pull_number: args.pullNumber,
        commit_id: args.commitId,
        path: args.path,
        line: args.line,
        side: "RIGHT",
        body,
      }),
      timeoutMs,
    );
    return { id: resp.data.id, url: resp.data.html_url };
  } catch (err) {
    // Spec non-break invariant 2: log and continue. The issue comment
    // is the contract path. A console.warn matches the existing
    // sweep.ts / review-worker.ts error-scoping pattern.
    console.warn("[patch-review-comment] post failed", {
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      pullNumber: args.pullNumber,
      path: args.path,
      line: args.line,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`patch-review-comment timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
