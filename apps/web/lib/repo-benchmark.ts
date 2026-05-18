import { logWarn } from "./log";

// Mission 6 — benchmark-class repo detection. The webhook calls this in
// parallel with isPublicRepo to decide whether a fresh review row should
// flip is_benchmark = true. A "benchmark-class repo" is any public repo
// that has BENCHMARK.md at root — explicit operator opt-in, the same
// shape as the public_receipt convention. Fail closed: anything other
// than a confirmed BENCHMARK.md file returns false so non-benchmark
// repos never accidentally surface on /benchmarks.

export type RepoBenchmarkOctokit = {
  rest: {
    repos: {
      getContent: (params: { owner: string; repo: string; path: string }) => Promise<{
        data: unknown;
      }>;
    };
  };
};

type CacheEntry = { value: boolean; ts: number };
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

// Exported for tests. Production code should not need to call this.
export function clearBenchmarkCache(): void {
  cache.clear();
}

export async function isBenchmarkRepo(
  octokit: RepoBenchmarkOctokit,
  owner: string,
  repo: string,
): Promise<boolean> {
  const key = `${owner}/${repo}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached !== undefined && now - cached.ts < CACHE_TTL_MS) {
    return cached.value;
  }
  const value = await lookup(octokit, owner, repo);
  cache.set(key, { value, ts: now });
  return value;
}

async function lookup(
  octokit: RepoBenchmarkOctokit,
  owner: string,
  repo: string,
): Promise<boolean> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: "BENCHMARK.md",
    });
    // getContent returns an array for directories. We require a single file
    // entry whose `type` is exactly "file" — a directory at this path or a
    // submodule or symlink doesn't count.
    if (Array.isArray(data)) return false;
    if (typeof data !== "object" || data === null) return false;
    const type = (data as { type?: unknown }).type;
    return type === "file";
  } catch (err) {
    // 404 is the expected "no benchmark file" path; treat it as a clean
    // negative and skip the warning. Anything else (rate limit, auth,
    // network) is unexpected and worth a warn so operators can see it.
    const status = (err as { status?: number } | null)?.status;
    if (status === 404) return false;
    const error = err instanceof Error ? err.message : String(err);
    logWarn("repo_benchmark.lookup_failed", { owner, repo, error, status });
    return false;
  }
}
