import { afterEach, describe, expect, it, vi } from "vitest";
import { isPublicRepo, type RepoVisibilityOctokit } from "./repo-visibility";

const captureLogs = (): { calls: string[] } => {
  const calls: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    calls.push(line);
  });
  return { calls };
};

afterEach(() => {
  vi.restoreAllMocks();
});

function mkOctokit(
  impl: (params: { owner: string; repo: string }) => Promise<{
    data: { private: boolean };
  }>,
): RepoVisibilityOctokit {
  return {
    rest: {
      repos: {
        get: vi.fn().mockImplementation(impl),
      },
    },
  };
}

describe("isPublicRepo", () => {
  it("returns true when the repo is public (private === false)", async () => {
    const octokit = mkOctokit(async () => ({ data: { private: false } }));
    const result = await isPublicRepo(octokit, "owner", "repo");
    expect(result).toBe(true);
  });

  it("returns false when the repo is private", async () => {
    const octokit = mkOctokit(async () => ({ data: { private: true } }));
    const result = await isPublicRepo(octokit, "owner", "repo");
    expect(result).toBe(false);
  });

  it("returns false and logs a structured warning on 404", async () => {
    const { calls } = captureLogs();
    const octokit = mkOctokit(async () => {
      const err = new Error("Not Found") as Error & { status: number };
      err.status = 404;
      throw err;
    });
    const result = await isPublicRepo(octokit, "ghost-owner", "ghost-repo");
    expect(result).toBe(false);
    expect(calls).toHaveLength(1);
    const entry = JSON.parse(calls[0]!) as Record<string, unknown>;
    expect(entry["event"]).toBe("repo_visibility.lookup_failed");
    expect(entry["level"]).toBe("warn");
    expect(entry["owner"]).toBe("ghost-owner");
    expect(entry["repo"]).toBe("ghost-repo");
    expect(entry["error"]).toBe("Not Found");
  });

  it("returns false and logs a warning on 403 / rate limit", async () => {
    const { calls } = captureLogs();
    const octokit = mkOctokit(async () => {
      throw new Error("API rate limit exceeded");
    });
    const result = await isPublicRepo(octokit, "owner", "repo");
    expect(result).toBe(false);
    expect(calls).toHaveLength(1);
    const entry = JSON.parse(calls[0]!) as Record<string, unknown>;
    expect(entry["event"]).toBe("repo_visibility.lookup_failed");
    expect(entry["error"]).toBe("API rate limit exceeded");
  });

  it("returns false and logs a warning on a raw network throw", async () => {
    const { calls } = captureLogs();
    const octokit = mkOctokit(async () => {
      throw new Error("ECONNRESET");
    });
    const result = await isPublicRepo(octokit, "owner", "repo");
    expect(result).toBe(false);
    expect(calls).toHaveLength(1);
    const entry = JSON.parse(calls[0]!) as Record<string, unknown>;
    expect(entry["error"]).toBe("ECONNRESET");
  });

  it("never returns true on an exception path even if private === false would have", async () => {
    // Defense-in-depth: a thrown error must always map to false. The behavior
    // can't be "fall back to the schema default" — the helper IS the gate.
    const octokit = mkOctokit(async () => {
      throw new Error("unexpected");
    });
    const result = await isPublicRepo(octokit, "o", "r");
    expect(result).toBe(false);
  });

  it("treats non-Error throws by coercing to string", async () => {
    const { calls } = captureLogs();
    const octokit = mkOctokit(async () => {
      // octokit can in theory reject with a non-Error value; we shouldn't
      // blow up trying to read .message off it.
      throw "string failure";
    });
    const result = await isPublicRepo(octokit, "o", "r");
    expect(result).toBe(false);
    const entry = JSON.parse(calls[0]!) as Record<string, unknown>;
    expect(entry["error"]).toBe("string failure");
  });
});
