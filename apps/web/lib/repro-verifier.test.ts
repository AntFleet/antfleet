import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  installCommandFor,
  probeOfflineDeps,
  runReproVerifier,
  type ReproVerifierIo,
} from "./repro-verifier";
import type { ExecArgs, ExecResult } from "./patch-verifier";
import type { Finding } from "./review-types";
import type { ReproTestSuggestion } from "@antfleet/cli/types";

// Repro-execution verifier (issue #133, Build 2b) — unit tests. The IO is
// mocked exactly like patch-verifier.test.ts so no real fs / child_process /
// network is touched. The ANTFLEET_REPRO_EXEC flag is flipped per-test because
// the whole exec path is gated behind it (default OFF).

function ok(stdout = "", stderr = ""): ExecResult {
  return { exitCode: 0, stdout, stderr, ms: 5, timedOut: false };
}

function fail(stderr = "bad", exitCode = 1): ExecResult {
  return { exitCode, stdout: "", stderr, ms: 5, timedOut: false };
}

function timedOut(): ExecResult {
  return { exitCode: null, stdout: "", stderr: "", ms: 5, timedOut: true };
}

// git verb extractor — same helper shape as patch-verifier.test.ts. `git -C
// <dir> <subcmd>` lands the subcmd at args[2]; a bare verb lands at args[0].
function gitVerb(args: string[]): string {
  if (args[0] === "-C") return args[2] ?? "";
  return args[0] ?? "";
}

const GIT_SETUP_VERBS = new Set(["init", "remote", "fetch", "checkout", "apply"]);

function mkIo(
  spec: {
    exec?: (args: ExecArgs) => Promise<ExecResult>;
    exists?: (path: string) => Promise<boolean>;
    lstatIsSymlink?: (path: string) => Promise<boolean>;
    writeFileNoClobber?: (path: string, contents: string, mode: number) => Promise<void>;
  } = {},
): ReproVerifierIo {
  let seq = 0;
  return {
    mkWorktreeRoot: vi.fn(async () => `/tmp/antfleet-pv-mock-${seq++}`),
    removeDir: vi.fn(async () => {}),
    // Default = a runnable JS project: a pnpm runner is detected and its deps
    // are present offline. Detection + dep-probe now run BEFORE the repro (so
    // both observations share the same dep state), so a test that wants to reach
    // the repro/apply/suite logic needs a detector + deps by default. Tests that
    // specifically exercise "no runner" / "deps absent" pass their own `exists`.
    exists:
      spec.exists ??
      vi.fn(async (p: string) => p.endsWith("pnpm-lock.yaml") || p.endsWith("node_modules")),
    readFile: vi.fn(async () => ""),
    writeTempFile: vi.fn(async () => "/tmp/antfleet-pv-mock-patch.diff"),
    exec: spec.exec ?? vi.fn(async () => ok()),
    now: (() => {
      let t = 0;
      return () => (t += 10);
    })(),
    lstatIsSymlink: spec.lstatIsSymlink ?? vi.fn(async () => false),
    writeFileNoClobber: spec.writeFileNoClobber ?? vi.fn(async () => {}),
  };
}

function mkFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    title: "f",
    category: "security",
    severity: "high",
    label: "blocking",
    confidence: "high",
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

function mkRepro(overrides: Partial<ReproTestSuggestion> = {}): ReproTestSuggestion {
  return {
    file: { path: "repro_test.py", contents: "assert True\n" },
    cmd: "pytest repro_test.py",
    rationale: null,
    modelId: "claude-opus-test",
    ...overrides,
  };
}

const BASE_ARGS = {
  repoSource: { kind: "online" as const, url: "https://github.com/o/r.git" },
  sha: "abc1234",
  patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n",
};

// Enable the gate for the reproduce/verify tests; each test that needs it OFF
// deletes the var explicitly. beforeEach/afterEach keep the env hermetic.
beforeEach(() => {
  process.env["ANTFLEET_REPRO_EXEC"] = "true";
});
afterEach(() => {
  delete process.env["ANTFLEET_REPRO_EXEC"];
});

describe("runReproVerifier", () => {
  it("returns repro_exec_disabled and spawns nothing when the flag is OFF", async () => {
    delete process.env["ANTFLEET_REPRO_EXEC"];
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async () => ok());
    const io = mkIo({ exec });
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro(),
      finding: mkFinding(),
      io,
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.inconclusiveReason).toBe("repro_exec_disabled");
    expect(exec).not.toHaveBeenCalled();
    expect(io.mkWorktreeRoot).not.toHaveBeenCalled();
    expect(io.writeFileNoClobber).not.toHaveBeenCalled();
  });

  it("returns no_repro when the model declined (cmd === null)", async () => {
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async () => ok());
    const io = mkIo({ exec });
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro({ cmd: null, file: null, rationale: "needs a live database" }),
      finding: mkFinding(),
      io,
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.inconclusiveReason).toBe("no_repro");
    expect(out.notes).toMatch(/needs a live database/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("returns repro_not_reproducing (never verified) when the repro does not exit 0 pre-patch", async () => {
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git" && GIT_SETUP_VERBS.has(gitVerb(args))) return ok();
      if (command === "pytest") return fail("bug did not fire", 1); // pre-patch repro fails
      return ok();
    });
    const exists = vi.fn(
      async (p: string) => p.endsWith("pnpm-lock.yaml") || p.endsWith("node_modules"),
    );
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro(),
      finding: mkFinding(),
      io: mkIo({ exec, exists }),
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.inconclusiveReason).toBe("repro_not_reproducing");
    expect(out.verdict).not.toBe("verified");
    expect(out.reproPreExitCode).toBe(1);
    // apply must NOT have run — we bailed before the patch.
    const ranApply = exec.mock.calls.some(
      ([a]) => a.command === "git" && gitVerb(a.args) === "apply",
    );
    expect(ranApply).toBe(false);
  });

  it("returns verified with BOTH observations when repro exits 0 pre, tests pass, repro non-0 post", async () => {
    let pytestCall = 0;
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git" && GIT_SETUP_VERBS.has(gitVerb(args))) return ok();
      if (command === "pnpm" && args[0] === "test") return ok("3 passed");
      if (command === "pytest") {
        pytestCall += 1;
        // 1st (pre-patch): exit 0 == bug reproduces. 2nd (post-patch): non-zero == fixed.
        return pytestCall === 1 ? ok("bug reproduced") : fail("AssertionError", 2);
      }
      return ok();
    });
    const exists = vi.fn(
      async (p: string) => p.endsWith("pnpm-lock.yaml") || p.endsWith("node_modules"),
    );
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro(),
      finding: mkFinding(),
      io: mkIo({ exec, exists }),
    });
    expect(out.verdict).toBe("verified");
    expect(out.reproPreExitCode).toBe(0);
    expect(out.reproPostExitCode).toBe(2);
    expect(out.reproCmd).toBe("pytest repro_test.py");
    expect(out.testCmd).toBe("pnpm test --offline");
    expect(out.notes).toMatch(/PROVED/);
    expect(pytestCall).toBe(2); // repro ran exactly twice
  });

  it("returns regressed when the repro still exits 0 post-patch (bug not closed)", async () => {
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git" && GIT_SETUP_VERBS.has(gitVerb(args))) return ok();
      if (command === "pnpm" && args[0] === "test") return ok();
      if (command === "pytest") return ok("still reproduces"); // exit 0 both pre AND post
      return ok();
    });
    const exists = vi.fn(
      async (p: string) => p.endsWith("pnpm-lock.yaml") || p.endsWith("node_modules"),
    );
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro(),
      finding: mkFinding(),
      io: mkIo({ exec, exists }),
    });
    expect(out.verdict).toBe("regressed");
    expect(out.reproPreExitCode).toBe(0);
    expect(out.reproPostExitCode).toBe(0);
    expect(out.notes).toMatch(/still exits 0 post-patch/);
  });

  it("returns regressed when the post-patch test suite fails", async () => {
    let pytestCall = 0;
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git" && GIT_SETUP_VERBS.has(gitVerb(args))) return ok();
      if (command === "pnpm" && args[0] === "test") return fail("2 failing"); // suite regressed
      if (command === "pytest") {
        pytestCall += 1;
        return ok("bug reproduced"); // pre-patch exit 0
      }
      return ok();
    });
    const exists = vi.fn(
      async (p: string) => p.endsWith("pnpm-lock.yaml") || p.endsWith("node_modules"),
    );
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro(),
      finding: mkFinding(),
      io: mkIo({ exec, exists }),
    });
    expect(out.verdict).toBe("regressed");
    expect(out.testExitCode).toBe(1);
    expect(out.notes).toMatch(/tests failed after patch/);
    // The post-patch repro must NOT have run — a failed suite short-circuits.
    expect(pytestCall).toBe(1);
  });

  it("refuses to write and returns unsafe_repro_write when a path component is a symlink", async () => {
    const writeFileNoClobber = vi.fn(async () => {});
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git" && GIT_SETUP_VERBS.has(gitVerb(args))) return ok();
      return ok();
    });
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro({ file: { path: "sub/repro_test.py", contents: "x" } }),
      finding: mkFinding(),
      io: mkIo({ exec, lstatIsSymlink: vi.fn(async () => true), writeFileNoClobber }),
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.inconclusiveReason).toBe("unsafe_repro_write");
    expect(out.notes).toMatch(/symlink/);
    expect(writeFileNoClobber).not.toHaveBeenCalled();
  });

  it("refuses to overwrite an existing file (no-clobber)", async () => {
    const writeFileNoClobber = vi.fn(async () => {
      const e = new Error("EEXIST: file already exists") as NodeJS.ErrnoException;
      e.code = "EEXIST";
      throw e;
    });
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git" && GIT_SETUP_VERBS.has(gitVerb(args))) return ok();
      return ok();
    });
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro(),
      finding: mkFinding(),
      io: mkIo({ exec, writeFileNoClobber }),
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.inconclusiveReason).toBe("unsafe_repro_write");
    expect(out.notes).toMatch(/no-clobber/);
  });

  it("refuses a repro file path under .git", async () => {
    const writeFileNoClobber = vi.fn(async () => {});
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git" && GIT_SETUP_VERBS.has(gitVerb(args))) return ok();
      return ok();
    });
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro({ file: { path: ".git/hooks/pre-commit", contents: "#!/bin/sh\n" } }),
      finding: mkFinding(),
      io: mkIo({ exec, writeFileNoClobber }),
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.inconclusiveReason).toBe("unsafe_repro_write");
    expect(out.notes).toMatch(/\.git/);
    expect(writeFileNoClobber).not.toHaveBeenCalled();
  });

  it("refuses a traversal repro file path", async () => {
    const writeFileNoClobber = vi.fn(async () => {});
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro({ file: { path: "../../etc/cron.d/x", contents: "x" } }),
      finding: mkFinding(),
      io: mkIo({ writeFileNoClobber }),
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.inconclusiveReason).toBe("unsafe_repro_write");
    expect(writeFileNoClobber).not.toHaveBeenCalled();
  });

  it("rejects a repro cmd with a control character before executing", async () => {
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async () => ok());
    const io = mkIo({ exec });
    const out = await runReproVerifier({
      ...BASE_ARGS,
      // Allowlisted "node " prefix but a smuggled 2nd line via a newline.
      repro: mkRepro({ cmd: "node ok.js\nrm -rf /", file: null }),
      finding: mkFinding(),
      io,
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.inconclusiveReason).toBe("invalid_input");
    expect(out.notes).toMatch(/allowlist \/ control-char/);
    expect(exec).not.toHaveBeenCalled();
    expect(io.mkWorktreeRoot).not.toHaveBeenCalled();
  });

  it("rejects a repro cmd whose runner is not allowlisted before executing", async () => {
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async () => ok());
    const io = mkIo({ exec });
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro({ cmd: "rm -rf /", file: null }),
      finding: mkFinding(),
      io,
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.inconclusiveReason).toBe("invalid_input");
    expect(exec).not.toHaveBeenCalled();
  });

  it("returns repro_timeout when the pre-patch repro is killed", async () => {
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git" && GIT_SETUP_VERBS.has(gitVerb(args))) return ok();
      if (command === "pytest") return timedOut();
      return ok();
    });
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro(),
      finding: mkFinding(),
      io: mkIo({ exec }),
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.inconclusiveReason).toBe("repro_timeout");
    expect(out.notes).toMatch(/pre-patch/);
  });

  it("returns patch_apply_failed (inconclusive) when git apply fails after a proven repro", async () => {
    let pytestCall = 0;
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git") {
        const verb = gitVerb(args);
        if (verb === "init" || verb === "remote" || verb === "fetch" || verb === "checkout")
          return ok();
        if (verb === "apply") return fail("patch does not apply", 1);
      }
      if (command === "pytest") {
        pytestCall += 1;
        return ok("bug reproduced");
      }
      return ok();
    });
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro(),
      finding: mkFinding(),
      io: mkIo({ exec }),
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.inconclusiveReason).toBe("patch_apply_failed");
    expect(out.reproPreExitCode).toBe(0);
    expect(pytestCall).toBe(1); // never ran post-patch
  });

  it("passes --unidiff-zero to git apply (adapter emits zero-context hunks)", async () => {
    // Root cause of the bench-potatopad patch_apply_failed pair (run
    // 29899755318): stock `git apply` rejects a mid-file zero-context hunk,
    // and the adapter only emits zero-context hunks.
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git" && GIT_SETUP_VERBS.has(gitVerb(args))) return ok();
      if (command === "pytest") return ok("bug reproduced");
      return ok();
    });
    await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro(),
      finding: mkFinding(),
      io: mkIo({ exec }),
    });
    const applyCalls = exec.mock.calls.filter(
      ([a]) => a.command === "git" && gitVerb(a.args) === "apply",
    );
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]?.[0].args).toContain("--unidiff-zero");
  });

  it("returns no_repo_url when the online url is null (after the flag + cmd gates)", async () => {
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repoSource: { kind: "online", url: null },
      repro: mkRepro(),
      finding: mkFinding(),
      io: mkIo(),
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.inconclusiveReason).toBe("no_repo_url");
  });

  it("tears down both the worktree AND the per-call HOME dir in finally", async () => {
    const removeDir = vi.fn(async () => {});
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async () => {
      throw new Error("exec crashed");
    });
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro(),
      finding: mkFinding(),
      io: { ...mkIo({ exec }), removeDir },
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.inconclusiveReason).toBe("exception");
    expect(removeDir).toHaveBeenCalledTimes(2);
  });

  it("returns no_runner (never verified) when no test runner is detected, even with a clean repro differential", async () => {
    let curlCall = 0;
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git" && GIT_SETUP_VERBS.has(gitVerb(args))) return ok();
      if (command === "curl") {
        curlCall += 1;
        return curlCall === 1 ? ok() : fail("connection refused", 7);
      }
      return ok();
    });
    // exists all-false → detectRunner returns "none". Detection now happens
    // BEFORE the repro, so with no runner we bail immediately: the repro never
    // runs at all (a repro differential alone is not a verified proof).
    const writeFileNoClobber = vi.fn(async () => {});
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro({ file: null, cmd: "curl http://localhost:8080/x" }),
      finding: mkFinding(),
      io: mkIo({ exec, writeFileNoClobber, exists: async () => false }),
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.verdict).not.toBe("verified");
    expect(out.inconclusiveReason).toBe("no_runner");
    expect(out.detector).toBe("none");
    expect(curlCall).toBe(0); // no runner → the repro never ran
    expect(writeFileNoClobber).not.toHaveBeenCalled();
  });

  it("returns deps_unavailable (never regressed) when a JS runner is detected but node_modules is absent", async () => {
    const suiteSpawns: string[] = [];
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git" && GIT_SETUP_VERBS.has(gitVerb(args))) return ok();
      if (command === "pnpm") {
        // The offline sandbox has no node_modules: a real suite spawn would die
        // "command not found" — which must never be read as `regressed`.
        suiteSpawns.push(command);
        return fail("vitest: not found", 127);
      }
      return ok();
    });
    // Lockfile present (runner detected), node_modules NOT present. Detection +
    // probe run before the repro, so we bail at deps_unavailable before the repro
    // or the suite ever runs.
    const exists = vi.fn(async (p: string) => p.endsWith("pnpm-lock.yaml"));
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro({ file: null, cmd: "curl http://localhost:8080/x" }),
      finding: mkFinding(),
      io: mkIo({ exec, exists }),
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.verdict).not.toBe("regressed");
    expect(out.inconclusiveReason).toBe("deps_unavailable");
    expect(out.detector).toBe("pnpm");
    expect(suiteSpawns).toEqual([]); // probe fails closed BEFORE spawning the suite
  });

  it("dep-prefetch: installs missing JS deps in the network seam, then reaches verified via the OFFLINE suite", async () => {
    let installed = false;
    let pyCall = 0;
    const offlineSteps: string[] = [];
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git" && GIT_SETUP_VERBS.has(gitVerb(args))) return ok();
      if (command === "pnpm" && args[0] === "test") {
        offlineSteps.push("suite");
        return ok("all pass");
      }
      if (command === "pytest") {
        pyCall += 1;
        offlineSteps.push("repro");
        return pyCall === 1 ? ok("reproduced") : fail("AssertionError", 2);
      }
      return ok();
    });
    // The network install seam: succeeds and makes node_modules appear.
    const execInstall = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(
      async ({ command, args }) => {
        expect(command).toBe("pnpm");
        expect(args).toContain("install");
        installed = true;
        return ok("added 42 packages");
      },
    );
    // pnpm-lock present (runner detected); node_modules absent UNTIL install runs.
    const exists = vi.fn(async (p: string) => {
      if (p.endsWith("pnpm-lock.yaml")) return true;
      if (p.endsWith("node_modules")) return installed;
      return false;
    });
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro(),
      finding: mkFinding(),
      io: { ...mkIo({ exec, exists }), execInstall },
    });
    expect(out.verdict).toBe("verified");
    expect(out.depPrefetched).toBe(true); // provenance: network install was used
    expect(execInstall).toHaveBeenCalledTimes(1);
    // Pre-repro, suite, post-repro all ran on the OFFLINE exec, in order.
    expect(offlineSteps).toEqual(["repro", "suite", "repro"]);
    // The install NEVER ran on the offline exec — only through the network seam.
    const installedOnOfflineExec = exec.mock.calls.some(
      ([a]) => a.command === "pnpm" && a.args[0] === "install",
    );
    expect(installedOnOfflineExec).toBe(false);
  });

  it("suite exit 127 (test runner not executable) is deps_unavailable, never regressed", async () => {
    let pytestCall = 0;
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git" && GIT_SETUP_VERBS.has(gitVerb(args))) return ok();
      if (command === "pnpm" && args[0] === "test") return fail("vitest: not found", 127);
      if (command === "pytest") {
        pytestCall += 1;
        return ok("reproduced"); // pre-repro reproduces
      }
      return ok();
    });
    // node_modules present as a dir (probe passes) but the test binary is missing
    // → the suite exits 127. Must NOT be classified as a patch regression.
    const exists = vi.fn(
      async (p: string) => p.endsWith("pnpm-lock.yaml") || p.endsWith("node_modules"),
    );
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro(),
      finding: mkFinding(),
      io: mkIo({ exec, exists }),
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.verdict).not.toBe("regressed");
    expect(out.inconclusiveReason).toBe("deps_unavailable");
    expect(out.notes).toMatch(/not executable/);
  });

  it("a fully-offline verified carries no depPrefetched flag", async () => {
    let pytestCall = 0;
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git" && GIT_SETUP_VERBS.has(gitVerb(args))) return ok();
      if (command === "pnpm" && args[0] === "test") return ok("pass");
      if (command === "pytest") {
        pytestCall += 1;
        return pytestCall === 1 ? ok("reproduced") : fail("fixed", 2);
      }
      return ok();
    });
    // deps already present offline → no install seam invoked.
    const exists = vi.fn(
      async (p: string) => p.endsWith("pnpm-lock.yaml") || p.endsWith("node_modules"),
    );
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro(),
      finding: mkFinding(),
      io: mkIo({ exec, exists }),
    });
    expect(out.verdict).toBe("verified");
    expect(out.depPrefetched).toBe(false);
  });

  it("dep-prefetch: a FAILED install stays deps_unavailable and never spawns the suite", async () => {
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git" && GIT_SETUP_VERBS.has(gitVerb(args))) return ok();
      return ok();
    });
    const execInstall = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async () =>
      fail("ENETUNREACH registry.npmjs.org", 1),
    );
    const exists = vi.fn(async (p: string) => p.endsWith("pnpm-lock.yaml")); // node_modules never appears
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro({ file: null, cmd: "curl http://localhost:8080/x" }),
      finding: mkFinding(),
      io: { ...mkIo({ exec, exists }), execInstall },
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.inconclusiveReason).toBe("deps_unavailable");
    expect(out.notes).toMatch(/install failed/);
    const ranSuite = exec.mock.calls.some(
      (c) => c[0].command === "pnpm" && c[0].args[0] === "test",
    );
    expect(ranSuite).toBe(false);
  });

  it("dep-prefetch: an install that exits 0 but produces no node_modules stays deps_unavailable", async () => {
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git" && GIT_SETUP_VERBS.has(gitVerb(args))) return ok();
      return ok();
    });
    const execInstall = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async () =>
      ok("up to date"),
    );
    const exists = vi.fn(async (p: string) => p.endsWith("pnpm-lock.yaml")); // node_modules still absent post-install
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro({ file: null, cmd: "curl http://localhost:8080/x" }),
      finding: mkFinding(),
      io: { ...mkIo({ exec, exists }), execInstall },
    });
    expect(out.inconclusiveReason).toBe("deps_unavailable");
    expect(out.notes).toMatch(/still unavailable after install/);
  });

  it("returns abnormal_exit (never verified) when the post-patch repro exits null without timing out", async () => {
    let pytestCall = 0;
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git" && GIT_SETUP_VERBS.has(gitVerb(args))) return ok();
      if (command === "pnpm" && args[0] === "test") return ok("all pass");
      if (command === "pytest") {
        pytestCall += 1;
        // pre: exit 0 (reproduces). post: null exit that is NOT a timeout
        // (signal / OOM / spawn failure) — must NOT be treated as "fixed".
        return pytestCall === 1
          ? ok("bug reproduced")
          : { exitCode: null, stdout: "", stderr: "killed", ms: 5, timedOut: false };
      }
      return ok();
    });
    const exists = vi.fn(
      async (p: string) => p.endsWith("pnpm-lock.yaml") || p.endsWith("node_modules"),
    );
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro(),
      finding: mkFinding(),
      io: mkIo({ exec, exists }),
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.verdict).not.toBe("verified");
    expect(out.inconclusiveReason).toBe("abnormal_exit");
    expect(out.reproPreExitCode).toBe(0);
    expect(pytestCall).toBe(2);
  });

  it("returns abnormal_exit (not regressed) when the post-patch test suite exits null without timing out", async () => {
    let pytestCall = 0;
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git" && GIT_SETUP_VERBS.has(gitVerb(args))) return ok();
      if (command === "pnpm" && args[0] === "test")
        return { exitCode: null, stdout: "", stderr: "runner crashed", ms: 5, timedOut: false };
      if (command === "pytest") {
        pytestCall += 1;
        return ok("bug reproduced"); // pre-patch exit 0
      }
      return ok();
    });
    const exists = vi.fn(
      async (p: string) => p.endsWith("pnpm-lock.yaml") || p.endsWith("node_modules"),
    );
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro(),
      finding: mkFinding(),
      io: mkIo({ exec, exists }),
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.verdict).not.toBe("regressed");
    expect(out.inconclusiveReason).toBe("abnormal_exit");
    // A patch is NOT dropped for an undecidable suite; post-patch repro skipped.
    expect(pytestCall).toBe(1);
  });

  it("removes the repro before the test suite and re-materialises it before the post-patch run", async () => {
    const removed: string[] = [];
    const written: string[] = [];
    let pytestCall = 0;
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git" && GIT_SETUP_VERBS.has(gitVerb(args))) return ok();
      if (command === "pnpm" && args[0] === "test") return ok("pass");
      if (command === "pytest") {
        pytestCall += 1;
        return pytestCall === 1 ? ok("reproduced") : fail("fixed", 1);
      }
      return ok();
    });
    const exists = vi.fn(
      async (p: string) => p.endsWith("pnpm-lock.yaml") || p.endsWith("node_modules"),
    );
    const io = mkIo({ exec, exists });
    io.removeDir = vi.fn(async (p: string) => {
      removed.push(p);
    });
    io.writeFileNoClobber = vi.fn(async (p: string) => {
      written.push(p);
    });
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro(),
      finding: mkFinding(),
      io,
    });
    expect(out.verdict).toBe("verified");
    // The repro leaf was removed before the suite (so the runner can't collect
    // the failing repro and flip a correct patch to regressed)…
    expect(removed.some((p) => p.endsWith("/repro_test.py"))).toBe(true);
    // …and written TWICE: the initial write + the pre-post-run re-materialise.
    expect(written.filter((p) => p.endsWith("/repro_test.py"))).toHaveLength(2);
  });

  it("refuses to write and returns unsafe_repro_write when the repro contents exceed the byte cap", async () => {
    const writeFileNoClobber = vi.fn(async () => {});
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git" && GIT_SETUP_VERBS.has(gitVerb(args))) return ok();
      return ok();
    });
    const huge = "a".repeat(20000); // well over REPRO_FILE_MAX_BYTES
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repro: mkRepro({ file: { path: "repro_test.py", contents: huge } }),
      finding: mkFinding(),
      io: mkIo({ exec, writeFileNoClobber }),
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.inconclusiveReason).toBe("unsafe_repro_write");
    expect(out.notes).toMatch(/exceed .*bytes/);
    expect(writeFileNoClobber).not.toHaveBeenCalled();
  });

  it("clones from an offline mirror and no URL reaches git argv", async () => {
    const MIRROR = "/mnt/mirrors/o-r.git";
    let remoteAddSource: string | null = null;
    let sawHttpArg = false;
    let pytestCall = 0;
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (args.some((a) => a.includes("http"))) sawHttpArg = true;
      if (command === "git") {
        const verb = gitVerb(args);
        // `git -C <wt> remote add origin -- <source>` → source is the last arg.
        if (verb === "remote") remoteAddSource = args[args.length - 1] ?? null;
        if (GIT_SETUP_VERBS.has(verb)) return ok();
      }
      if (command === "pnpm" && args[0] === "test") return ok("pass");
      if (command === "pytest") {
        pytestCall += 1;
        return pytestCall === 1 ? ok("reproduced") : fail("fixed", 2);
      }
      return ok();
    });
    // exists=true for the mirror dir AND the pnpm lockfile; symlink=false.
    const exists = vi.fn(
      async (p: string) =>
        p === MIRROR || p.endsWith("pnpm-lock.yaml") || p.endsWith("node_modules"),
    );
    const out = await runReproVerifier({
      ...BASE_ARGS,
      repoSource: { kind: "offline", mirrorDir: MIRROR },
      repro: mkRepro(),
      finding: mkFinding(),
      io: mkIo({ exec, exists }),
    });
    expect(out.verdict).toBe("verified");
    // Cloned from the LOCAL mirror; no http URL ever reached git argv.
    expect(remoteAddSource).toBe(MIRROR);
    expect(sawHttpArg).toBe(false);
    expect(out.reproPreExitCode).toBe(0);
    expect(out.reproPostExitCode).toBe(2);
  });

  it("rejects an unsafe offline mirrorDir shape (relative / traversal / dash) without spawning", async () => {
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async () => ok());
    const io = mkIo({ exec });
    for (const bad of ["relative/mirror.git", "/mnt/../etc", "-x/mirror.git"]) {
      const out = await runReproVerifier({
        ...BASE_ARGS,
        repoSource: { kind: "offline", mirrorDir: bad },
        repro: mkRepro(),
        finding: mkFinding(),
        io,
      });
      expect(out.verdict).toBe("inconclusive");
      expect(out.inconclusiveReason).toBe("invalid_input");
    }
    // Shape gate runs before any worktree/spawn.
    expect(io.mkWorktreeRoot).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("returns invalid_input when the offline mirrorDir is missing or a symlink", async () => {
    const MIRROR = "/mnt/mirrors/o-r.git";
    const exec = vi.fn<(args: ExecArgs) => Promise<ExecResult>>(async ({ command, args }) => {
      if (command === "git" && GIT_SETUP_VERBS.has(gitVerb(args))) return ok();
      return ok();
    });
    const missing = await runReproVerifier({
      ...BASE_ARGS,
      repoSource: { kind: "offline", mirrorDir: MIRROR },
      repro: mkRepro(),
      finding: mkFinding(),
      io: mkIo({ exec, exists: vi.fn(async () => false) }),
    });
    expect(missing.inconclusiveReason).toBe("invalid_input");
    expect(missing.notes).toMatch(/missing or a symlink/);

    const symlinked = await runReproVerifier({
      ...BASE_ARGS,
      repoSource: { kind: "offline", mirrorDir: MIRROR },
      repro: mkRepro(),
      finding: mkFinding(),
      io: mkIo({ exec, exists: vi.fn(async () => true), lstatIsSymlink: vi.fn(async () => true) }),
    });
    expect(symlinked.inconclusiveReason).toBe("invalid_input");
    expect(symlinked.notes).toMatch(/missing or a symlink/);
    // The reject path must NOT spawn git — the mirror check gates the clone.
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("probeOfflineDeps", () => {
  const W = "/tmp/wt";
  function io(files: Record<string, string>): Parameters<typeof probeOfflineDeps>[0] {
    return {
      ...({} as Parameters<typeof probeOfflineDeps>[0]),
      exists: async (p: string) => p in files,
      readFile: async (p: string) => {
        const c = files[p];
        if (c === undefined) throw new Error("ENOENT");
        return c;
      },
    } as Parameters<typeof probeOfflineDeps>[0];
  }

  it("pnpm/npm: unavailable without node_modules, available with a real directory", async () => {
    expect(await probeOfflineDeps(io({}), W, "pnpm")).toMatch(/node_modules/);
    expect(await probeOfflineDeps(io({}), W, "npm")).toMatch(/node_modules/);
    const withDeps = io({ [`${W}/node_modules`]: "" });
    expect(await probeOfflineDeps(withDeps, W, "pnpm")).toBeNull();
    expect(await probeOfflineDeps(withDeps, W, "npm")).toBeNull();
  });

  it("pnpm/npm: a committed FILE named node_modules does not count (hostile false-regressed vector)", async () => {
    const fileNotDir = {
      ...io({ [`${W}/node_modules`]: "i am a file" }),
      isDirectory: async () => false,
    };
    expect(await probeOfflineDeps(fileNotDir, W, "pnpm")).toMatch(/node_modules/);
    const realDir = {
      ...io({ [`${W}/node_modules`]: "" }),
      isDirectory: async () => true,
    };
    expect(await probeOfflineDeps(realDir, W, "pnpm")).toBeNull();
  });

  it("go: always unavailable until the exec image ships a go toolchain", async () => {
    // The image has no go — ANY go suite would die command-not-found → false
    // regressed. Unconditional, no go.mod read (also removes that hostile-read
    // surface). Restore the vendor/require checks when go lands in the image.
    expect(await probeOfflineDeps(io({ [`${W}/vendor`]: "" }), W, "go")).toMatch(/toolchain/);
    expect(await probeOfflineDeps(io({ [`${W}/go.mod`]: "module x\n" }), W, "go")).toMatch(
      /toolchain/,
    );
  });

  it("pytest: declared deps are unavailable offline; stdlib-only projects run", async () => {
    const withReqs = io({ [`${W}/requirements.txt`]: "requests==2.32.0\n" });
    expect(await probeOfflineDeps(withReqs, W, "pytest")).toMatch(/requirements/);
    const commentsOnly = io({ [`${W}/requirements.txt`]: "# none\n\n" });
    expect(await probeOfflineDeps(commentsOnly, W, "pytest")).toBeNull();
    const pyprojDeps = io({
      [`${W}/pyproject.toml`]: '[project]\nname = "x"\ndependencies = [\n  "requests",\n]\n',
    });
    expect(await probeOfflineDeps(pyprojDeps, W, "pytest")).toMatch(/pyproject/);
    const pyprojEmpty = io({
      [`${W}/pyproject.toml`]: '[project]\nname = "x"\ndependencies = []\n',
    });
    expect(await probeOfflineDeps(pyprojEmpty, W, "pytest")).toBeNull();
    expect(await probeOfflineDeps(io({}), W, "pytest")).toBeNull();
  });

  it("pytest: [project] scoping, quoted keys, and comment-only arrays (codex review #163)", async () => {
    // dependencies under [tool.*] is metadata, not an install requirement.
    const toolTable = io({
      [`${W}/pyproject.toml`]: '[tool.example]\ndependencies = ["metadata-only"]\n',
    });
    expect(await probeOfflineDeps(toolTable, W, "pytest")).toBeNull();
    // A comment inside an empty array body is still empty.
    const commentedEmpty = io({
      [`${W}/pyproject.toml`]: "[project]\ndependencies = [ # intentionally empty\n]\n",
    });
    expect(await probeOfflineDeps(commentedEmpty, W, "pytest")).toBeNull();
    // TOML allows the key to be quoted.
    const quotedKey = io({
      [`${W}/pyproject.toml`]: '[project]\n"dependencies" = ["requests"]\n',
    });
    expect(await probeOfflineDeps(quotedKey, W, "pytest")).toMatch(/pyproject/);
  });

  it("pytest: symlinked or oversized manifests are refused, not read (hostile-read guard)", async () => {
    const symlinked = {
      ...io({ [`${W}/requirements.txt`]: "never read" }),
      isSymlink: async () => true,
    };
    expect(await probeOfflineDeps(symlinked, W, "pytest")).toMatch(/unreadable or unsafe/);
    const oversized = {
      ...io({ [`${W}/pyproject.toml`]: "never read" }),
      isSymlink: async () => false,
      statSize: async () => 100_000_000,
    };
    expect(await probeOfflineDeps(oversized, W, "pytest")).toMatch(/unreadable or unsafe/);
  });

  it("never gates a runner kind it does not understand", async () => {
    expect(await probeOfflineDeps(io({}), W, "none")).toBeNull();
  });
});

describe("installCommandFor", () => {
  it("pnpm/npm install with --ignore-scripts and forced dev deps; go/pytest null", () => {
    const pnpm = installCommandFor("pnpm");
    expect(pnpm).toEqual({
      command: "pnpm",
      args: ["install", "--frozen-lockfile", "--prod=false", "--ignore-scripts"],
    });
    const npm = installCommandFor("npm");
    expect(npm).toEqual({ command: "npm", args: ["ci", "--include=dev", "--ignore-scripts"] });
    // --ignore-scripts is the containment lever: assert it is never dropped.
    expect(pnpm?.args).toContain("--ignore-scripts");
    expect(npm?.args).toContain("--ignore-scripts");
    // Not offline-installable in this build.
    expect(installCommandFor("go")).toBeNull();
    expect(installCommandFor("pytest")).toBeNull();
    expect(installCommandFor("none")).toBeNull();
  });
});
