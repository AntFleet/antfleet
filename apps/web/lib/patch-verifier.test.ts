import { describe, it, expect, vi } from "vitest";
import {
  runPatchVerifier,
  applyPatchVerifier,
  sniffPocCommand,
  minimalEnv,
  type ExecArgs,
  type ExecResult,
  type PatchVerifierIo,
  type PatchVerifyOutcome,
} from "./patch-verifier";
import type { Finding } from "./review-types";

function ok(stdout = "", stderr = ""): ExecResult {
  return { exitCode: 0, stdout, stderr, ms: 5, timedOut: false };
}

function fail(stderr = "bad", exitCode = 1): ExecResult {
  return { exitCode, stdout: "", stderr, ms: 5, timedOut: false };
}

function mkIo(
  spec: {
    exec?: (args: ExecArgs) => Promise<ExecResult>;
    exists?: (path: string) => Promise<boolean>;
  } = {},
): PatchVerifierIo {
  const removed: string[] = [];
  // mkWorktreeRoot is now called twice — once for the worktree, once for
  // the per-call HOME dir — so return a fresh path each call. Tests
  // already in scope only inspect the count of removeDir calls, not the
  // paths, so unique synthetic paths are fine.
  let seq = 0;
  return {
    mkWorktreeRoot: vi.fn(async () => `/tmp/antfleet-pv-mock-${seq++}`),
    removeDir: vi.fn(async (p: string) => {
      removed.push(p);
    }),
    exists: spec.exists ?? vi.fn(async () => false),
    readFile: vi.fn(async () => ""),
    writeTempFile: vi.fn(async () => "/tmp/antfleet-pv-mock-patch.diff"),
    exec: spec.exec ?? vi.fn(async () => ok()),
    now: (() => {
      let t = 0;
      return () => (t += 10);
    })(),
  };
}

function mkFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    title: "f",
    category: "security",
    severity: "high",
    label: "blocking",
    confidence: "high",
    // Default: no evidence — bypasses the patch-adapter step so the
    // legacy verifier tests focus on the run-test / run-PoC / cleanup
    // surfaces. A separate test covers the adapter wire-up explicitly.
    evidence: [],
    reasoning: "r",
    reproduction: null,
    recommendation: "rec",
    whyTestsDoNotAlreadyCoverThis: "",
    suggestedRegressionTest: null,
    minimumFixScope: "",
    requiresPolicyReview: false,
    upstreamOrigin: null,
    ...overrides,
  };
}

// Matcher for the SHA-checkout flow (init / remote add / fetch / checkout).
// `git -C <dir> <subcmd>` lands `subcmd` at args[1] when the test passes via
// the runSetupSteps shape; `git clone` / `git apply` come through with the
// verb at args[0]. The helper returns the verb regardless.
function gitVerb(args: string[]): string {
  if (args[0] === "-C") return args[2] ?? "";
  return args[0] ?? "";
}

describe("runPatchVerifier", () => {
  it("returns verified when tests pass and PoC stops exiting 0", async () => {
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git") {
        const verb = gitVerb(args);
        if (
          verb === "init" ||
          verb === "remote" ||
          verb === "fetch" ||
          verb === "checkout" ||
          verb === "apply"
        )
          return ok();
      }
      if (command === "pnpm" && args[0] === "test") return ok("3 passed");
      if (command === "pytest") return fail("AssertionError"); // PoC fails post-patch
      return ok();
    });
    const exists = vi.fn(async (p: string) => p.endsWith("pnpm-lock.yaml"));
    const out = await runPatchVerifier({
      repoUrl: "https://github.com/o/r.git",
      sha: "abc1234",
      patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n",
      finding: mkFinding({ reproduction: "pytest tests/test_repro.py" }),
      io: mkIo({ exec, exists }),
    });
    expect(out.verdict).toBe("verified");
    expect(out.detector).toBe("pnpm");
    expect(out.testCmd).toBe("pnpm test --offline");
    expect(out.pocCmd).toBe("pytest tests/test_repro.py");
  });

  it("returns regressed when the patch fails to apply", async () => {
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git") {
        const verb = gitVerb(args);
        if (verb === "init" || verb === "remote" || verb === "fetch" || verb === "checkout")
          return ok();
        if (verb === "apply") return fail("patch does not apply");
      }
      return ok();
    });
    const out = await runPatchVerifier({
      repoUrl: "https://github.com/o/r.git",
      sha: "abc1234",
      patch: "bogus",
      finding: mkFinding(),
      io: mkIo({ exec }),
    });
    expect(out.verdict).toBe("regressed");
    expect(out.notes).toMatch(/git apply failed/);
  });

  it("passes --unidiff-zero to git apply (adapter emits zero-context hunks)", async () => {
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git" && gitVerb(args) === "apply") {
        // Stock `git apply` rejects a zero-context hunk unless it touches
        // beginning/end of file; without the flag, mid-file patches from the
        // adapter fail here and get misclassified as `regressed`.
        expect(args).toContain("--unidiff-zero");
        return ok();
      }
      return ok();
    });
    await runPatchVerifier({
      repoUrl: "https://github.com/o/r.git",
      sha: "abc1234",
      patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3,1 +3,1 @@\n-old\n+new\n",
      finding: mkFinding(),
      io: mkIo({ exec }),
    });
    const applyCalls = exec.mock.calls.filter(
      ([a]) => a.command === "git" && gitVerb(a.args) === "apply",
    );
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]?.[0].args).toContain("--unidiff-zero");
  });

  it("returns inconclusive when fetch of the reviewed SHA fails", async () => {
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git") {
        const verb = gitVerb(args);
        if (verb === "init" || verb === "remote") return ok();
        if (verb === "fetch") return fail("Could not resolve sha", 128);
      }
      return ok();
    });
    const out = await runPatchVerifier({
      repoUrl: "https://github.com/o/r.git",
      sha: "deadbeef",
      patch: "diff",
      finding: mkFinding(),
      io: mkIo({ exec }),
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.notes).toMatch(/fetch.*failed/);
  });

  it("returns regressed when the post-patch test suite fails", async () => {
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git") {
        const verb = gitVerb(args);
        if (
          verb === "init" ||
          verb === "remote" ||
          verb === "fetch" ||
          verb === "checkout" ||
          verb === "apply"
        )
          return ok();
      }
      if (command === "pnpm" && args[0] === "test") return fail("3 failing");
      return ok();
    });
    const exists = vi.fn(async (p: string) => p.endsWith("pnpm-lock.yaml"));
    const out = await runPatchVerifier({
      repoUrl: "https://github.com/o/r.git",
      sha: "abc1234",
      patch: "diff…",
      finding: mkFinding(),
      io: mkIo({ exec, exists }),
    });
    expect(out.verdict).toBe("regressed");
    expect(out.testExitCode).toBe(1);
    expect(out.notes).toMatch(/tests failed/);
  });

  it("returns regressed when tests pass but PoC still exits 0 (bug not closed)", async () => {
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git") {
        const verb = gitVerb(args);
        if (
          verb === "init" ||
          verb === "remote" ||
          verb === "fetch" ||
          verb === "checkout" ||
          verb === "apply"
        )
          return ok();
      }
      if (command === "pnpm" && args[0] === "test") return ok();
      if (command === "pytest") return ok("still exploits");
      return ok();
    });
    const exists = vi.fn(async (p: string) => p.endsWith("pnpm-lock.yaml"));
    const out = await runPatchVerifier({
      repoUrl: "https://github.com/o/r.git",
      sha: "abcdef0",
      patch: "diff",
      finding: mkFinding({ reproduction: "pytest tests/test_repro.py" }),
      io: mkIo({ exec, exists }),
    });
    expect(out.verdict).toBe("regressed");
    expect(out.notes).toMatch(/PoC still exits 0/);
  });

  it("returns inconclusive when no test runner is detected", async () => {
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git") {
        const verb = gitVerb(args);
        if (
          verb === "init" ||
          verb === "remote" ||
          verb === "fetch" ||
          verb === "checkout" ||
          verb === "apply"
        )
          return ok();
      }
      return ok();
    });
    const out = await runPatchVerifier({
      repoUrl: "https://github.com/o/r.git",
      sha: "abcdef0",
      patch: "diff",
      finding: mkFinding(),
      io: mkIo({ exec, exists: vi.fn(async () => false) }),
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.detector).toBe("none");
    expect(out.notes).toMatch(/no test runner detected/);
  });

  it("returns inconclusive when tests pass but no PoC command is available", async () => {
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git") {
        const verb = gitVerb(args);
        if (
          verb === "init" ||
          verb === "remote" ||
          verb === "fetch" ||
          verb === "checkout" ||
          verb === "apply"
        )
          return ok();
      }
      if (command === "pnpm" && args[0] === "test") return ok();
      return ok();
    });
    const exists = vi.fn(async (p: string) => p.endsWith("pnpm-lock.yaml"));
    const out = await runPatchVerifier({
      repoUrl: "https://github.com/o/r.git",
      sha: "abcdef0",
      patch: "diff",
      finding: mkFinding({ reproduction: null }),
      io: mkIo({ exec, exists }),
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.notes).toMatch(/no PoC command available/);
    expect(out.testExitCode).toBe(0);
  });

  it("runs the adapter when finding evidence is present and applies the rebuilt patch", async () => {
    const file = `line 1
line 2
def foo():
    return 1
line 5
`;
    const brokenPatch = `--- a/src/x.py
+++ b/src/x.py
@@
-def foo():
-    return 1
+def foo():
+    return 2
`;
    const patches: string[] = [];
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git") {
        const verb = gitVerb(args);
        if (verb === "init" || verb === "remote" || verb === "fetch" || verb === "checkout")
          return ok();
        if (verb === "apply") return ok();
      }
      if (command === "pnpm" && args[0] === "test") return ok();
      return ok();
    });
    const readFile = vi.fn(async () => file);
    const writeTempFile = vi.fn(async (contents: string) => {
      patches.push(contents);
      return "/tmp/patch.diff";
    });
    const exists = vi.fn(async (p: string) => p.endsWith("pnpm-lock.yaml"));
    const out = await runPatchVerifier({
      repoUrl: "https://github.com/o/r.git",
      sha: "abcdef0",
      patch: brokenPatch,
      finding: mkFinding({
        evidence: [{ path: "src/x.py", startLine: 3, endLine: 4, symbol: null, quote: null }],
      }),
      io: { ...mkIo({ exec, exists }), readFile, writeTempFile },
    });
    expect(out.verdict).toBe("inconclusive"); // tests pass, no PoC, no evidence reproducer
    expect(patches[0]).toMatch(/^diff --git a\/src\/x\.py b\/src\/x\.py/u);
    expect(patches[0]).toMatch(/@@ -3,2 \+3,2 @@/u);
  });

  it("returns inconclusive when the adapter cannot locate the patch block", async () => {
    const file = "totally unrelated content";
    const brokenPatch = `--- a/src/x.py
+++ b/src/x.py
@@
-missing line
+replacement
`;
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git") {
        const verb = gitVerb(args);
        if (verb === "init" || verb === "remote" || verb === "fetch" || verb === "checkout")
          return ok();
      }
      return ok();
    });
    const readFile = vi.fn(async () => file);
    const out = await runPatchVerifier({
      repoUrl: "https://github.com/o/r.git",
      sha: "abcdef0",
      patch: brokenPatch,
      finding: mkFinding({
        evidence: [{ path: "src/x.py", startLine: 1, endLine: 1, symbol: null, quote: null }],
      }),
      io: { ...mkIo({ exec }), readFile },
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.notes).toMatch(/patch-adapter could not normalise/);
  });

  it("returns inconclusive when repoUrl is null (e.g. serverless)", async () => {
    const out = await runPatchVerifier({
      repoUrl: null,
      sha: "abcdef0",
      patch: "diff",
      finding: mkFinding(),
      io: mkIo(),
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.notes).toMatch(/requires a repoUrl/);
  });

  it("tears down both the worktree AND the per-call HOME dir in finally", async () => {
    const removeDir = vi.fn(async () => {});
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async () => {
      throw new Error("exec crashed");
    });
    const io: PatchVerifierIo = {
      ...mkIo({ exec }),
      removeDir,
    };
    const out = await runPatchVerifier({
      repoUrl: "https://github.com/o/r.git",
      sha: "abcdef0",
      patch: "diff",
      finding: mkFinding(),
      io,
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.notes).toMatch(/verifier threw/);
    // Two cleanup calls: worktree + per-call HOME dir.
    expect(removeDir).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe repoUrl (non-http scheme, leading dash)", async () => {
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async () => ok());
    for (const repoUrl of [
      "--upload-pack=/bin/sh",
      "file:///etc/passwd",
      "ssh://github.com/o/r.git",
      "https://user:pass@github.com/o/r.git",
    ]) {
      const out = await runPatchVerifier({
        repoUrl,
        sha: "abcdef0",
        patch: "diff",
        finding: mkFinding(),
        io: mkIo({ exec }),
      });
      expect(out.verdict).toBe("inconclusive");
      expect(out.notes).toMatch(/unsafe repoUrl/);
      expect(out.inconclusiveReason).toBe("invalid_input");
    }
  });

  it("rejects an evidence path that escapes the worktree (path traversal)", async () => {
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git") {
        const verb = gitVerb(args);
        if (verb === "init" || verb === "remote" || verb === "fetch" || verb === "checkout")
          return ok();
      }
      return ok();
    });
    const readFile = vi.fn(async () => "should not be read");
    const out = await runPatchVerifier({
      repoUrl: "https://github.com/o/r.git",
      sha: "abcdef0",
      patch: "diff",
      finding: mkFinding({
        evidence: [
          { path: "../../../etc/passwd", startLine: 1, endLine: 1, symbol: null, quote: null },
        ],
      }),
      io: { ...mkIo({ exec }), readFile },
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.notes).toMatch(/out-of-worktree evidence path/);
    expect(out.inconclusiveReason).toBe("invalid_input");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("refuses to dereference a symlinked evidence path", async () => {
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git") {
        const verb = gitVerb(args);
        if (verb === "init" || verb === "remote" || verb === "fetch" || verb === "checkout")
          return ok();
      }
      return ok();
    });
    const readFile = vi.fn(async () => "should not be read");
    const isSymlink = vi.fn(async () => true);
    const out = await runPatchVerifier({
      repoUrl: "https://github.com/o/r.git",
      sha: "abcdef0",
      patch: "diff",
      finding: mkFinding({
        evidence: [{ path: "evidence-sink", startLine: 1, endLine: 1, symbol: null, quote: null }],
      }),
      io: { ...mkIo({ exec }), readFile, isSymlink },
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.notes).toMatch(/refused to follow symlink/);
    expect(out.inconclusiveReason).toBe("invalid_input");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("refuses to read evidence files larger than the cap", async () => {
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git") {
        const verb = gitVerb(args);
        if (verb === "init" || verb === "remote" || verb === "fetch" || verb === "checkout")
          return ok();
      }
      return ok();
    });
    const readFile = vi.fn(async () => "should not be read");
    const statSize = vi.fn(async () => 5_000_000); // 5 MiB
    const out = await runPatchVerifier({
      repoUrl: "https://github.com/o/r.git",
      sha: "abcdef0",
      patch: "diff",
      finding: mkFinding({
        evidence: [{ path: "src/x.py", startLine: 1, endLine: 1, symbol: null, quote: null }],
      }),
      io: { ...mkIo({ exec }), readFile, statSize },
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.notes).toMatch(/exceeds adapter cap/);
    expect(out.inconclusiveReason).toBe("evidence_unreadable");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("rejects unsafe sha (non-hex, leading dash, too short)", async () => {
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async () => ok());
    for (const sha of ["--upload-pack=/bin/sh", "deadbe", "zzzzzzzz", ""]) {
      const out = await runPatchVerifier({
        repoUrl: "https://github.com/o/r.git",
        sha,
        patch: "diff",
        finding: mkFinding(),
        io: mkIo({ exec }),
      });
      expect(out.verdict).toBe("inconclusive");
      expect(out.notes).toMatch(/non-hex sha/);
      expect(out.inconclusiveReason).toBe("invalid_input");
    }
  });
});

function mkPocFinding(reproduction: string | null): Finding {
  return {
    title: "f",
    category: "security",
    severity: "high",
    label: "blocking",
    confidence: "high",
    evidence: [],
    reasoning: "r",
    reproduction,
    recommendation: "x",
    whyTestsDoNotAlreadyCoverThis: "",
    suggestedRegressionTest: null,
    minimumFixScope: "",
    requiresPolicyReview: false,
    upstreamOrigin: null,
  };
}

describe("sniffPocCommand", () => {
  const base = mkPocFinding;

  it("returns the command when it matches an allowed prefix", () => {
    expect(sniffPocCommand(base("pytest tests/test_exploit.py"))).toBe(
      "pytest tests/test_exploit.py",
    );
    expect(sniffPocCommand(base("go test ./fuzz"))).toBe("go test ./fuzz");
    expect(sniffPocCommand(base("node scripts/exploit.js"))).toBe("node scripts/exploit.js");
  });

  it("returns null when reproduction is null or empty", () => {
    expect(sniffPocCommand(base(null))).toBeNull();
    expect(sniffPocCommand(base("   "))).toBeNull();
  });

  it("rejects commands containing shell metacharacters", () => {
    expect(sniffPocCommand(base("pytest x.py | tee log"))).toBeNull();
    expect(sniffPocCommand(base("node x.js > out.txt"))).toBeNull();
    expect(sniffPocCommand(base("bash -c $(echo bad)"))).toBeNull();
    expect(sniffPocCommand(base("pytest x.py; rm -rf /"))).toBeNull();
  });

  it("rejects commands not in the allowlist", () => {
    expect(sniffPocCommand(base("rm -rf /"))).toBeNull();
    expect(sniffPocCommand(base("python -c 'print(1)'"))).toBeNull();
    expect(sniffPocCommand(base("./exploit.sh"))).toBeNull();
  });

  it("rejects very long commands", () => {
    expect(sniffPocCommand(base("pytest " + "x".repeat(600)))).toBeNull();
  });
});

function mkApplierOutcome(verdict: PatchVerifyOutcome["verdict"]): PatchVerifyOutcome {
  return {
    verdict,
    detector: "pnpm",
    testCmd: "pnpm test",
    testExitCode: verdict === "regressed" ? 1 : 0,
    testMs: 5,
    pocCmd: null,
    pocExitCode: null,
    pocMs: null,
    ms: 10,
    notes: `outcome=${verdict}`,
    worktreePath: "/tmp/antfleet-pv-mock",
    error: null,
    inconclusiveReason: verdict === "inconclusive" ? "test_timeout" : null,
  };
}

function mkApplierOutcomeMap(): {
  byIndex: Map<number, { patch: string; modelId: string } & Record<string, unknown>>;
  inlineByIndex: Map<number, { patch: string; modelId: string } & Record<string, unknown>>;
} {
  const byIndex = new Map<number, { patch: string; modelId: string } & Record<string, unknown>>();
  byIndex.set(0, { patch: "patch-0", modelId: "claude-opus-4-7" });
  byIndex.set(1, { patch: "patch-1", modelId: "claude-opus-4-7" });
  byIndex.set(2, { patch: "patch-2", modelId: "claude-opus-4-7" });
  const inlineByIndex = new Map(byIndex);
  return { byIndex, inlineByIndex };
}

describe("applyPatchVerifier", () => {
  const mkOutcome = mkApplierOutcome;
  const mkOutcomeMap = mkApplierOutcomeMap;

  it("drops regressed entries from both maps and tags the rest with verifyStatus", async () => {
    const findings: Finding[] = [
      { ...mkFinding(), title: "f0" },
      { ...mkFinding(), title: "f1" },
      { ...mkFinding(), title: "f2" },
    ];
    const verdicts: Array<PatchVerifyOutcome["verdict"]> = [
      "verified",
      "regressed",
      "inconclusive",
    ];
    const runVerifier = vi.fn().mockImplementation(async (_args) => mkOutcome(verdicts.shift()!));
    const outcome = mkOutcomeMap();
    const result = await applyPatchVerifier({
      outcome,
      repoUrl: "https://github.com/o/r.git",
      sha: "abcdef0",
      findingAt: (i) => findings[i],
      findingIdAt: (i) => `fid-${i}`,
      runVerifier,
      io: mkIo(),
    });
    expect(result.droppedIndexes).toEqual([1]);
    expect(outcome.byIndex.has(1)).toBe(false);
    expect(outcome.inlineByIndex.has(1)).toBe(false);
    expect((outcome.byIndex.get(0) as Record<string, unknown>)["verifyStatus"]).toBe("verified");
    expect((outcome.byIndex.get(2) as Record<string, unknown>)["verifyStatus"]).toBe(
      "inconclusive",
    );
    expect((outcome.inlineByIndex.get(0) as Record<string, unknown>)["verifyStatus"]).toBe(
      "verified",
    );
    expect((outcome.inlineByIndex.get(2) as Record<string, unknown>)["verifyStatus"]).toBe(
      "inconclusive",
    );
    expect(result.rows.map((r) => r.outcome.verdict)).toEqual([
      "verified",
      "regressed",
      "inconclusive",
    ]);
    expect(result.rows.map((r) => r.findingId)).toEqual(["fid-0", "fid-1", "fid-2"]);
  });

  it("skips indexes whose finding lookup returns undefined", async () => {
    const runVerifier = vi.fn();
    const outcome = mkOutcomeMap();
    const result = await applyPatchVerifier({
      outcome,
      repoUrl: "https://github.com/o/r.git",
      sha: "abcdef0",
      findingAt: () => undefined,
      findingIdAt: () => null,
      runVerifier,
      io: mkIo(),
    });
    expect(runVerifier).not.toHaveBeenCalled();
    expect(result.droppedIndexes).toHaveLength(0);
    expect(result.rows).toHaveLength(0);
  });
});

describe("minimalEnv", () => {
  it("includes PATH but excludes secrets the parent process may carry", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    process.env["GITHUB_TOKEN"] = "ghp_test";
    process.env["DATABASE_URL"] = "postgres://x";
    const env = minimalEnv();
    expect(env["PATH"]).toBeDefined();
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["GITHUB_TOKEN"]).toBeUndefined();
    expect(env["DATABASE_URL"]).toBeUndefined();
    expect(env["NODE_ENV"]).toBe("test");
    expect(env["CI"]).toBe("1");
    expect(env["HOME"]).toBe("/tmp"); // default
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["GITHUB_TOKEN"];
    delete process.env["DATABASE_URL"];
  });

  it("blocks IMDS metadata endpoints by env config", () => {
    const env = minimalEnv();
    expect(env["AWS_EC2_METADATA_DISABLED"]).toBe("true");
    expect(env["GCE_METADATA_HOST"]).toBe("invalid.localhost");
  });

  it("threads the per-call HOME dir into HOME and all XDG_*_HOME slots", () => {
    const env = minimalEnv("/tmp/antfleet-pv-home-xyz");
    expect(env["HOME"]).toBe("/tmp/antfleet-pv-home-xyz");
    expect(env["XDG_CONFIG_HOME"]).toBe("/tmp/antfleet-pv-home-xyz/.config");
    expect(env["XDG_DATA_HOME"]).toBe("/tmp/antfleet-pv-home-xyz/.local/share");
    expect(env["XDG_CACHE_HOME"]).toBe("/tmp/antfleet-pv-home-xyz/.cache");
  });
});
