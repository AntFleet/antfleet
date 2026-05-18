import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearBenchmarkCache, isBenchmarkRepo, type RepoBenchmarkOctokit } from "./repo-benchmark";

const captureLogs = (): { calls: string[] } => {
  const calls: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    calls.push(line);
  });
  return { calls };
};

beforeEach(() => {
  clearBenchmarkCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mkOctokit(
  impl: (params: { owner: string; repo: string; path: string }) => Promise<{
    data: unknown;
  }>,
): RepoBenchmarkOctokit & { calls: number } {
  const fn = vi.fn().mockImplementation(impl);
  return {
    rest: {
      repos: {
        getContent: fn,
      },
    },
    get calls() {
      return fn.mock.calls.length;
    },
  };
}

describe("isBenchmarkRepo", () => {
  it("returns true when BENCHMARK.md is a file at root", async () => {
    const octokit = mkOctokit(async () => ({
      data: { type: "file", name: "BENCHMARK.md", path: "BENCHMARK.md" },
    }));
    const result = await isBenchmarkRepo(octokit, "owner", "repo");
    expect(result).toBe(true);
  });

  it("returns false when getContent returns a directory listing (array)", async () => {
    const octokit = mkOctokit(async () => ({ data: [] }));
    const result = await isBenchmarkRepo(octokit, "owner", "repo");
    expect(result).toBe(false);
  });

  it("returns false when type is not 'file' (e.g. submodule)", async () => {
    const octokit = mkOctokit(async () => ({
      data: { type: "submodule", name: "BENCHMARK.md" },
    }));
    const result = await isBenchmarkRepo(octokit, "owner", "repo");
    expect(result).toBe(false);
  });

  it("returns false on 404 WITHOUT logging a warning (expected miss)", async () => {
    const { calls } = captureLogs();
    const octokit = mkOctokit(async () => {
      const err = new Error("Not Found") as Error & { status: number };
      err.status = 404;
      throw err;
    });
    const result = await isBenchmarkRepo(octokit, "ghost-owner", "ghost-repo");
    expect(result).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("returns false and logs a warning on 403", async () => {
    const { calls } = captureLogs();
    const octokit = mkOctokit(async () => {
      const err = new Error("Forbidden") as Error & { status: number };
      err.status = 403;
      throw err;
    });
    const result = await isBenchmarkRepo(octokit, "owner", "repo");
    expect(result).toBe(false);
    expect(calls).toHaveLength(1);
    const entry = JSON.parse(calls[0]!) as Record<string, unknown>;
    expect(entry["event"]).toBe("repo_benchmark.lookup_failed");
    expect(entry["level"]).toBe("warn");
    expect(entry["status"]).toBe(403);
  });

  it("returns false and logs a warning on 500", async () => {
    const { calls } = captureLogs();
    const octokit = mkOctokit(async () => {
      const err = new Error("Internal Server Error") as Error & { status: number };
      err.status = 500;
      throw err;
    });
    const result = await isBenchmarkRepo(octokit, "owner", "repo");
    expect(result).toBe(false);
    expect(calls).toHaveLength(1);
    const entry = JSON.parse(calls[0]!) as Record<string, unknown>;
    expect(entry["event"]).toBe("repo_benchmark.lookup_failed");
  });

  it("returns false and logs a warning on a non-status network error", async () => {
    const { calls } = captureLogs();
    const octokit = mkOctokit(async () => {
      throw new Error("ECONNRESET");
    });
    const result = await isBenchmarkRepo(octokit, "owner", "repo");
    expect(result).toBe(false);
    expect(calls).toHaveLength(1);
    const entry = JSON.parse(calls[0]!) as Record<string, unknown>;
    expect(entry["error"]).toBe("ECONNRESET");
  });

  it("memoizes within the TTL — second call returns the cached value without hitting Octokit", async () => {
    const octokit = mkOctokit(async () => ({
      data: { type: "file", name: "BENCHMARK.md" },
    }));
    await isBenchmarkRepo(octokit, "owner", "repo");
    await isBenchmarkRepo(octokit, "owner", "repo");
    expect(octokit.calls).toBe(1);
  });

  it("memoizes negative results too — 404 cached, second call does not refetch", async () => {
    const octokit = mkOctokit(async () => {
      const err = new Error("Not Found") as Error & { status: number };
      err.status = 404;
      throw err;
    });
    const a = await isBenchmarkRepo(octokit, "owner", "repo");
    const b = await isBenchmarkRepo(octokit, "owner", "repo");
    expect(a).toBe(false);
    expect(b).toBe(false);
    expect(octokit.calls).toBe(1);
  });

  it("refetches once the TTL has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const octokit = mkOctokit(async () => ({
      data: { type: "file", name: "BENCHMARK.md" },
    }));
    await isBenchmarkRepo(octokit, "owner", "repo");
    expect(octokit.calls).toBe(1);
    // Advance past 1h TTL
    vi.setSystemTime(new Date("2026-01-01T01:00:01Z"));
    await isBenchmarkRepo(octokit, "owner", "repo");
    expect(octokit.calls).toBe(2);
  });

  it("keys cache by owner/repo — different repos independently cached", async () => {
    let calls = 0;
    const octokit: RepoBenchmarkOctokit = {
      rest: {
        repos: {
          getContent: vi.fn().mockImplementation(async () => {
            calls++;
            return { data: { type: "file", name: "BENCHMARK.md" } };
          }),
        },
      },
    };
    await isBenchmarkRepo(octokit, "ownerA", "repo1");
    await isBenchmarkRepo(octokit, "ownerA", "repo2");
    await isBenchmarkRepo(octokit, "ownerB", "repo1");
    expect(calls).toBe(3);
  });
});
