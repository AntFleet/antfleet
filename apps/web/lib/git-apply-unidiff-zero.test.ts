import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Real-git behavioral test for the `--unidiff-zero` fix (repro-exec run
// 29899755318): the patch adapter's renderUnifiedDiff emits zero-context
// hunks, and stock `git apply` rejects a zero-context hunk unless it touches
// the beginning or end of the file (match_beginning/match_end safety). Both
// verifiers therefore pass `--unidiff-zero`. This suite pins the underlying
// git behavior with a real repo so a future "drop the weird flag" cleanup
// fails loudly instead of silently re-breaking mid-file patches.

// Mid-file zero-context hunk in the exact shape renderUnifiedDiff emits:
// diff --git header, ---/+++ pair, `@@ -N,c +N,c @@` header, no context lines.
const ZERO_CONTEXT_PATCH = [
  "diff --git a/app.txt b/app.txt",
  "--- a/app.txt",
  "+++ b/app.txt",
  "@@ -3,1 +3,1 @@",
  "-line three",
  "+line three patched",
  "",
].join("\n");

let repo: string;

function git(args: string[], opts: { allowFail?: boolean } = {}): { code: number; err: string } {
  try {
    execFileSync("git", ["-C", repo, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, err: "" };
  } catch (e) {
    if (!opts.allowFail) throw e;
    const err = e as { status?: number; stderr?: Buffer };
    return { code: err.status ?? -1, err: err.stderr?.toString() ?? "" };
  }
}

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), "antfleet-unidiff-zero-"));
  git(["init", "-q"]);
  writeFileSync(
    path.join(repo, "app.txt"),
    "line one\nline two\nline three\nline four\nline five\n",
  );
  git(["add", "app.txt"]);
  git(["commit", "-q", "-m", "seed"]);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("git apply on adapter-shaped zero-context hunks", () => {
  it("stock `git apply --index` rejects a mid-file zero-context hunk", () => {
    writeFileSync(path.join(repo, "zc.patch"), ZERO_CONTEXT_PATCH);
    const res = git(["apply", "--index", "--", "zc.patch"], { allowFail: true });
    expect(res.code).not.toBe(0);
    expect(res.err).toMatch(/does not apply/);
  });

  it("`git apply --index --unidiff-zero` applies the same hunk cleanly", () => {
    writeFileSync(path.join(repo, "zc.patch"), ZERO_CONTEXT_PATCH);
    const res = git(["apply", "--index", "--unidiff-zero", "--", "zc.patch"], {
      allowFail: true,
    });
    expect(res.code).toBe(0);
    // The staged content reflects the patched line — apply really landed.
    const staged = execFileSync("git", ["-C", repo, "show", ":app.txt"]).toString();
    expect(staged).toContain("line three patched");
    // Reset index + worktree so test order never leaks state.
    git(["reset", "-q", "--hard"]);
  });
});
