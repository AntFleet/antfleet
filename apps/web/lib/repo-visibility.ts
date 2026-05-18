import { logWarn } from "./log";

// Mission 5 — public-repo receipt visibility default. The webhook calls this
// before recordReview() to decide whether a fresh review row's
// publicReceipt should default true (public GitHub repo, no privacy
// expectation) or false (private repo, or any uncertainty about
// visibility). Fail closed is load-bearing: if the lookup raises for any
// reason (404, 403, rate limit, network), we return false so we never
// accidentally surface findings from a private repo on the public
// /receipts page. The schema-level default also stays false, which means
// a code path that bypasses this helper still lands on the safe side.

// Structural subset of Octokit we actually call. Lets test mocks satisfy
// the type without pulling in the full @octokit/rest surface.
export type RepoVisibilityOctokit = {
  rest: {
    repos: {
      get: (params: { owner: string; repo: string }) => Promise<{
        data: { private: boolean };
      }>;
    };
  };
};

export async function isPublicRepo(
  octokit: RepoVisibilityOctokit,
  owner: string,
  repo: string,
): Promise<boolean> {
  try {
    const { data } = await octokit.rest.repos.get({ owner, repo });
    return data.private === false;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logWarn("repo_visibility.lookup_failed", { owner, repo, error });
    return false;
  }
}
