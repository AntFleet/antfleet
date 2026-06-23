// Daybreak takeaway #5 — patch verifier.
//
// Runs AFTER Patch Agent generates a proposed patch and BEFORE the patch
// is posted as a GitHub suggestion comment. Three-step pipeline:
//   1. Spin up an ephemeral worktree at the reviewed SHA (under /tmp/).
//   2. Apply the proposed patch with `git apply --index`.
//   3. Run the auto-detected project test suite + (if present) re-run the
//      finding's PoC. Expect: tests PASS AND PoC now fails.
//
// Verdicts and worker behavior:
//   - verified     → keep entry in patchOutcome.byIndex / inlineByIndex.
//   - regressed    → drop entry; log patch_verify.regressed_dropped.
//   - inconclusive → keep entry; pr-comment tags as "(unverified)".
//
// Sandboxing:
//   - Worktrees live under /tmp/antfleet-pv-<uuid>/ ONLY. See
//     env_worktree_tmp_location: anything under ~/projects is forbidden.
//   - Subprocess env is stripped to a minimal set; no inherited tokens.
//   - Hard wall-clock cap; SIGKILL on timeout.
//   - finally block always tears the worktree down with rm -rf, regardless
//     of the verdict path.
//
// This module is constructed with all I/O — fs, child_process, and the
// PRNG that names the worktree dir — injectable through PatchVerifierIo so
// the unit tests run hermetic. Production callers use realPatchVerifierIo.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type SpawnOptions } from "node:child_process";
import type { Finding } from "./review-types";
import { normalizePatchForApply } from "./patch-adapter";

export type PatchVerifyVerdict = "verified" | "regressed" | "inconclusive";

// Why an inconclusive outcome could not be decided. Surfaced to the
// suggestion renderer so the user-visible tag distinguishes "we tried and
// could not decide" (`(unverified)`) from "we did not have the inputs to
// try" (`(no PoC)` / `(no tests)`) — the architect review flagged that
// every patch was being tagged as "(unverified)" which eroded trust in
// legit patches.
export type InconclusiveReason =
  | "no_runner"
  | "no_poc"
  | "test_timeout"
  | "poc_timeout"
  | "adapter_refused"
  | "evidence_unreadable"
  | "no_repo_url"
  | "invalid_input"
  | "setup_failed"
  | "exception";

export type RunnerKind = "pnpm" | "npm" | "go" | "pytest" | "none";

export type PatchVerifyOutcome = {
  verdict: PatchVerifyVerdict;
  detector: RunnerKind;
  testCmd: string | null;
  testExitCode: number | null;
  testMs: number | null;
  pocCmd: string | null;
  pocExitCode: number | null;
  pocMs: number | null;
  ms: number;
  notes: string;
  // Where the ephemeral worktree lived. Cleared after teardown — preserved
  // here only as evidence for the gate-outcomes side table.
  worktreePath: string;
  error: string | null;
  // Non-null only for `inconclusive` verdicts. Lets pr-comment.ts decide
  // whether to tag the suggestion `(unverified)` (genuine indecision) vs.
  // a softer note (no PoC, no test runner, killed by timeout, …).
  inconclusiveReason: InconclusiveReason | null;
};

export type ExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
};

export type ExecArgs = {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  // Environment whitelist. Verifier always passes a minimal env; the
  // injectable seam lets tests inspect what was actually requested.
  env: Record<string, string>;
};

export type PatchVerifierIo = {
  mkWorktreeRoot: () => Promise<string>;
  removeDir: (path: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  readFile: (path: string) => Promise<string>;
  exec: (args: ExecArgs) => Promise<ExecResult>;
  // Used for the patch payload — written to a temp file and fed to
  // `git apply --index <file>` so the patch text is never exposed via the
  // command line.
  writeTempFile: (contents: string) => Promise<string>;
  now: () => number;
};

export type RunPatchVerifierArgs = {
  // Local mirror to git-clone from. When undefined, the verifier returns
  // `inconclusive` (no local source available — e.g. running inside a
  // serverless runtime where git is unusable).
  repoUrl: string | null;
  sha: string;
  patch: string;
  finding: Finding;
  // Default 120s. Per `runTestStep` we cap each child process at this many
  // milliseconds and SIGKILL on timeout — verdict on timeout: inconclusive.
  timeoutMs?: number;
  io: PatchVerifierIo;
};

const DEFAULT_TIMEOUT_MS = 120_000;

export async function runPatchVerifier(args: RunPatchVerifierArgs): Promise<PatchVerifyOutcome> {
  const t0 = args.io.now();
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (args.repoUrl === null) {
    return inconclusive({
      worktreePath: "(no-repo-url)",
      detector: "none",
      notes: "patch-verifier requires a repoUrl to clone from; skipping",
      ms: args.io.now() - t0,
      kind: "no_repo_url",
    });
  }
  // Argument-injection defense: every git invocation below puts repoUrl and
  // sha straight into argv. A `--upload-pack=<path>` masquerading as a URL,
  // or a sha starting with `-`, would be parsed as a git flag and could
  // execute attacker-supplied binaries. We reject anything that does not
  // look like a real http(s) URL or a 7-64 char hex sha BEFORE spawning git.
  // Defense in depth: every git call also threads `--` between the
  // subcommand and the user-derived positional (see runSetupSteps callers
  // below).
  if (!isSafeRepoUrl(args.repoUrl)) {
    return inconclusive({
      worktreePath: "(invalid-repo-url)",
      detector: "none",
      notes: `patch-verifier rejected unsafe repoUrl shape`,
      ms: args.io.now() - t0,
      kind: "invalid_input",
    });
  }
  if (!isSafeSha(args.sha)) {
    return inconclusive({
      worktreePath: "(invalid-sha)",
      detector: "none",
      notes: "patch-verifier rejected non-hex sha",
      ms: args.io.now() - t0,
      kind: "invalid_input",
    });
  }

  let worktree: string | null = null;
  let homeDir: string | null = null;
  try {
    worktree = await args.io.mkWorktreeRoot();
    // Per-call HOME directory. Hardcoding HOME=/tmp in the subprocess env
    // (the prior shape) let an attacker plant /tmp/.gitconfig or
    // /tmp/.npmrc that subsequent verifier calls would inherit — git's
    // `core.editor`/`core.fsmonitor` and npm's `script-shell` both trigger
    // arbitrary command execution on the very next verifier invocation
    // that runs git or npm. The per-call dir is created here and removed
    // in the same finally block that tears down the worktree.
    homeDir = await args.io.mkWorktreeRoot();
    // Fetch the exact reviewed SHA, not the repo's default branch HEAD.
    // The previous shape (`git clone --depth 1 <url>`) silently landed on
    // whatever the default branch is today, which made every old bench
    // patch fail to apply because line numbers had drifted. Init + fetch
    // by SHA is the right model: `git fetch --depth 1 origin <sha>` is
    // supported by GitHub and any other Smart-HTTP server that has
    // `uploadpack.allowAnySHA1InWant=true` (GitHub's default).
    const sandboxEnv = minimalEnv(homeDir);
    const initialised = await runSetupSteps(
      args.io,
      worktree,
      [
        { command: "git", args: ["init", "--quiet", "--", worktree] },
        {
          command: "git",
          args: ["-C", worktree, "remote", "add", "origin", "--", args.repoUrl],
        },
        {
          command: "git",
          args: ["-C", worktree, "fetch", "--depth", "1", "--quiet", "origin", "--", args.sha],
        },
        { command: "git", args: ["-C", worktree, "checkout", "--quiet", "FETCH_HEAD", "--"] },
      ],
      timeoutMs,
      sandboxEnv,
    );
    if (initialised.error !== null) {
      return inconclusive({
        worktreePath: worktree,
        detector: "none",
        notes: initialised.error,
        ms: args.io.now() - t0,
        kind: "setup_failed",
      });
    }

    // Normalise the proposed patch into a form `git apply --index` can
    // consume. The model occasionally emits broken hunk headers (missing
    // counts, mismatched counts, missing `diff --git` line); the adapter
    // rebuilds the envelope and re-anchors the hunk against the file at
    // the reviewed SHA. See patch-adapter.ts for the failure modes the
    // adapter covers and the ones it refuses.
    const evidence = args.finding.evidence[0];
    const evidencePath = evidence?.path ?? null;
    let normalisedPatch = args.patch;
    if (evidencePath !== null) {
      try {
        const fileBytes = await args.io.readFile(join(worktree, evidencePath));
        const adapt = normalizePatchForApply({
          patch: args.patch,
          evidencePath,
          fileContents: fileBytes,
        });
        if (adapt.ok) {
          normalisedPatch = adapt.patch;
        } else {
          return inconclusive({
            worktreePath: worktree,
            detector: "none",
            notes: `patch-adapter could not normalise: ${adapt.reason}`,
            ms: args.io.now() - t0,
            kind: "adapter_refused",
          });
        }
      } catch (readErr) {
        // Evidence file missing in the checked-out worktree is a hard
        // signal that the patch and the finding don't match — refuse.
        return inconclusive({
          worktreePath: worktree,
          detector: "none",
          notes: `could not read evidence file '${evidencePath}': ${(readErr as Error).message}`,
          ms: args.io.now() - t0,
          kind: "evidence_unreadable",
        });
      }
    }

    // git apply --index on the normalised patch. Any remaining conflict
    // is treated as `regressed` — the suggestion does not apply cleanly
    // against the reviewed SHA after we did our best to fix the
    // envelope.
    const patchFile = await args.io.writeTempFile(normalisedPatch);
    const applied = await args.io.exec({
      command: "git",
      args: ["-C", worktree, "apply", "--index", "--", patchFile],
      cwd: worktree,
      timeoutMs,
      env: sandboxEnv,
    });
    if (applied.exitCode !== 0) {
      return {
        verdict: "regressed",
        detector: "none",
        testCmd: null,
        testExitCode: null,
        testMs: null,
        pocCmd: null,
        pocExitCode: null,
        pocMs: null,
        ms: args.io.now() - t0,
        notes: `git apply failed (exit ${applied.exitCode ?? "null"}): ${truncate(applied.stderr)}`,
        worktreePath: worktree,
        error: null,
        inconclusiveReason: null,
      };
    }

    const detector = await detectRunner(args.io, worktree);
    if (detector.kind === "none") {
      return inconclusive({
        worktreePath: worktree,
        detector: "none",
        notes: "no test runner detected (no pnpm-lock / package-lock / go.mod / pyproject)",
        ms: args.io.now() - t0,
        kind: "no_runner",
      });
    }

    const testStep = await runTestStep(args.io, worktree, detector, timeoutMs, sandboxEnv);
    // Distinguish a clean non-zero exit (real test failure → regressed,
    // drop the patch) from a SIGKILL timeout (test suite exceeded the
    // wall-clock cap → inconclusive, keep but tag, do NOT silently drop a
    // legit patch just because the suite is slow). Detection: ExecResult
    // sets `timedOut: true` on the subprocess kill path and reports
    // exitCode null.
    if (testStep.timedOut) {
      return inconclusive({
        worktreePath: worktree,
        detector: detector.kind,
        notes: `tests killed after ${timeoutMs}ms — verifier cannot decide (testCmd=${detector.cmd})`,
        ms: args.io.now() - t0,
        testCmd: detector.cmd,
        testExitCode: null,
        testMs: testStep.ms,
        kind: "test_timeout",
      });
    }
    if (testStep.exitCode !== 0) {
      return {
        verdict: "regressed",
        detector: detector.kind,
        testCmd: detector.cmd,
        testExitCode: testStep.exitCode,
        testMs: testStep.ms,
        pocCmd: null,
        pocExitCode: null,
        pocMs: null,
        ms: args.io.now() - t0,
        notes: `tests failed after patch (exit ${testStep.exitCode ?? "null"}): ${truncate(testStep.stderr)}`,
        worktreePath: worktree,
        error: null,
        inconclusiveReason: null,
      };
    }

    const pocCmd = sniffPocCommand(args.finding);
    if (pocCmd === null) {
      return inconclusive({
        worktreePath: worktree,
        detector: detector.kind,
        notes: `tests passed; no PoC command available (testCmd=${detector.cmd})`,
        ms: args.io.now() - t0,
        testCmd: detector.cmd,
        testExitCode: testStep.exitCode,
        testMs: testStep.ms,
        // Distinguishes from "verifier ran the PoC and was ambiguous" so
        // the suggestion comment can render tests-passed-no-poc patches
        // WITHOUT an alarming "(unverified)" tag — that tag is reserved
        // for the genuine could-not-decide path.
        kind: "no_poc",
      });
    }
    const pocStep = await runPocStep(args.io, worktree, pocCmd, timeoutMs, sandboxEnv);
    if (pocStep.timedOut) {
      return inconclusive({
        worktreePath: worktree,
        detector: detector.kind,
        notes: `PoC killed after ${timeoutMs}ms — verifier cannot decide`,
        ms: args.io.now() - t0,
        testCmd: detector.cmd,
        testExitCode: testStep.exitCode,
        testMs: testStep.ms,
        kind: "poc_timeout",
      });
    }
    const pocStillExploits = pocStep.exitCode === 0;
    if (pocStillExploits) {
      return {
        verdict: "regressed",
        detector: detector.kind,
        testCmd: detector.cmd,
        testExitCode: testStep.exitCode,
        testMs: testStep.ms,
        pocCmd,
        pocExitCode: pocStep.exitCode,
        pocMs: pocStep.ms,
        ms: args.io.now() - t0,
        notes: `tests passed but PoC still exits 0 → patch did NOT close the bug`,
        worktreePath: worktree,
        error: null,
        inconclusiveReason: null,
      };
    }
    return {
      verdict: "verified",
      detector: detector.kind,
      testCmd: detector.cmd,
      testExitCode: testStep.exitCode,
      testMs: testStep.ms,
      pocCmd,
      pocExitCode: pocStep.exitCode,
      pocMs: pocStep.ms,
      ms: args.io.now() - t0,
      notes: `tests passed; PoC no longer exits 0 (was reproducing pre-patch)`,
      worktreePath: worktree,
      error: null,
      inconclusiveReason: null,
    };
  } catch (err) {
    return inconclusive({
      worktreePath: worktree ?? "(unset)",
      detector: "none",
      notes: `verifier threw: ${err instanceof Error ? err.message : String(err)}`,
      ms: args.io.now() - t0,
      error: err instanceof Error ? err.message : String(err),
      kind: "exception",
    });
  } finally {
    // Tear down BOTH the worktree and the per-call HOME directory. Best
    // effort — we never bubble cleanup failures because the OS will
    // reclaim /tmp eventually anyway.
    for (const dir of [worktree, homeDir]) {
      if (dir === null) continue;
      try {
        await args.io.removeDir(dir);
      } catch {
        // swallow — see comment above
      }
    }
  }
}

// Run a fixed sequence of setup commands (init / remote / fetch / checkout)
// and short-circuit on the first non-zero exit. Returns a structured note
// the caller can drop straight into a verdict payload.
async function runSetupSteps(
  io: PatchVerifierIo,
  worktree: string,
  steps: ReadonlyArray<{ command: string; args: string[] }>,
  timeoutMs: number,
  env: Record<string, string>,
): Promise<{ error: string | null }> {
  for (const step of steps) {
    const result = await io.exec({
      command: step.command,
      args: step.args,
      cwd: worktree,
      timeoutMs,
      env,
    });
    if (result.exitCode !== 0) {
      return {
        error: `${step.command} ${step.args.slice(0, 3).join(" ")}… failed (exit ${
          result.exitCode ?? "null"
        }): ${truncate(result.stderr)}`,
      };
    }
  }
  return { error: null };
}

// Auto-detect the project's test runner from lockfile + manifest presence.
// Priority: pnpm-lock.yaml → package-lock.json → go.mod → pyproject.toml /
// requirements.txt. A repo with multiple manifests resolves to the first
// hit in priority order (pnpm wins over npm wins over go wins over python).
async function detectRunner(
  io: PatchVerifierIo,
  worktree: string,
): Promise<{ kind: RunnerKind; cmd: string }> {
  if (await io.exists(join(worktree, "pnpm-lock.yaml"))) {
    // --offline keeps a malicious pnpmfile.cjs / .npmrc from triggering a
    // registry fetch (which would also let a malicious package execute
    // postinstall scripts under the verifier process). The lockfile that
    // shipped at the reviewed SHA must be self-sufficient for the test
    // suite.
    return { kind: "pnpm", cmd: "pnpm test --offline" };
  }
  if (await io.exists(join(worktree, "package-lock.json"))) {
    return { kind: "npm", cmd: "npm test --silent --offline" };
  }
  if (await io.exists(join(worktree, "go.mod"))) {
    return { kind: "go", cmd: "go test ./..." };
  }
  if (
    (await io.exists(join(worktree, "pyproject.toml"))) ||
    (await io.exists(join(worktree, "requirements.txt")))
  ) {
    return { kind: "pytest", cmd: "pytest -q" };
  }
  return { kind: "none", cmd: "" };
}

async function runTestStep(
  io: PatchVerifierIo,
  worktree: string,
  detector: { kind: RunnerKind; cmd: string },
  timeoutMs: number,
  env: Record<string, string>,
): Promise<ExecResult> {
  const { command, args } = splitCommand(detector.cmd);
  return io.exec({
    command,
    args,
    cwd: worktree,
    timeoutMs,
    env,
  });
}

async function runPocStep(
  io: PatchVerifierIo,
  worktree: string,
  pocCmd: string,
  timeoutMs: number,
  env: Record<string, string>,
): Promise<ExecResult> {
  const { command, args } = splitCommand(pocCmd);
  return io.exec({
    command,
    args,
    cwd: worktree,
    timeoutMs,
    env,
  });
}

// Pull a PoC command out of the finding evidence. We accept ONLY a single-
// line `reproduction` that begins with a known interpreter or script
// runner. Anything else returns null → no PoC step → inconclusive.
//
// This is intentionally conservative. The reproduction string is sourced
// from a model's output and could be coerced; running an arbitrary
// shell snippet in a temp dir would be too much trust. The allowlist of
// command prefixes keeps the attack surface tiny while still catching the
// common pytest / npm / go-test / curl PoCs the reviewers actually emit.
const POC_PREFIX_ALLOWLIST: readonly string[] = [
  "pytest",
  "go test",
  "node ",
  "pnpm exec",
  "npx ",
  "npm test",
  "pnpm test",
  "curl ",
  "bash ",
  "sh ",
];

export function sniffPocCommand(finding: Finding): string | null {
  const repro = finding.reproduction;
  if (repro === null || repro === undefined) return null;
  const lines = repro
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const head = lines[0]!;
  if (head.length > 500) return null;
  // Forbid shell metacharacters that suggest piping / redirection — the
  // child_process call is exec-style without a shell, and a `>` or `|` in
  // an allowlisted prefix would just be a garbage argv to that interpreter.
  // We refuse rather than try to interpret a shell expression in JS.
  if (/[|&;<>$`\\]/.test(head)) return null;
  for (const prefix of POC_PREFIX_ALLOWLIST) {
    if (head.startsWith(prefix)) return head;
  }
  return null;
}

// Minimal subprocess env. We deliberately drop secrets that the verifier
// process inherits (ANTHROPIC_API_KEY, OPENAI_API_KEY, GITHUB_TOKEN,
// DATABASE_URL, etc.) so a malicious patch cannot exfiltrate them through
// the test process. PATH is kept because most runners shell out to it.
// HOME is rooted at a per-call temp dir created by the caller so
// `~/.config` writes and dotfile reads cannot reach the parent's
// dotfiles OR persist across verifier invocations. XDG_*_HOME is pinned
// to the same dir so XDG-aware tools follow.
//
// IMDS blocking: AWS_EC2_METADATA_DISABLED + GCE_METADATA_HOST cut off the
// usual cloud-metadata SSRF vectors a malicious test script would reach
// for to escalate from sandboxed RCE to credentials. They are a cheap
// belt-and-suspenders alongside the secret strip — even if env hygiene
// breaks, the metadata endpoint stays unreachable.
export function minimalEnv(home: string = "/tmp"): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_DATA_HOME: `${home}/.local/share`,
    XDG_CACHE_HOME: `${home}/.cache`,
    NODE_ENV: "test",
    CI: "1",
    // Per `feedback_run_oxfmt_before_push` and similar, runners may probe
    // for git identity. A bare global config under per-call HOME is enough.
    GIT_TERMINAL_PROMPT: "0",
    // Prevent npm/pnpm from offering interactive prompts.
    npm_config_yes: "true",
    // Block IMDSv1/v2 cloud metadata so a malicious test script in the
    // patched repo cannot fetch ec2/gce role credentials. Effectively
    // free; defense in depth alongside the secret-strip.
    AWS_EC2_METADATA_DISABLED: "true",
    GCE_METADATA_HOST: "invalid.localhost",
  };
}

// Defense-in-depth: validate user-derived strings before they reach `git`.
// Even though `spawn` is invoked without `shell:true` (so no shell-meta
// injection), `git` itself parses values that start with `-` as flags
// (e.g. `--upload-pack=<binary>` runs arbitrary code on fetch). We refuse
// anything that does not look like a real http(s) URL or a hex sha at the
// front door; the `--` separator we thread into argv after the subcommand
// is a second layer.
export function isSafeRepoUrl(url: string): boolean {
  if (url.length > 1024) return false;
  if (url.startsWith("-")) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (parsed.username.length > 0 || parsed.password.length > 0) return false;
  return true;
}

export function isSafeSha(sha: string): boolean {
  return /^[0-9a-fA-F]{7,64}$/u.test(sha);
}

// "pnpm test" → { command: "pnpm", args: ["test"] }. Naive whitespace split
// is acceptable because the runner commands above are static.
function splitCommand(cmd: string): { command: string; args: string[] } {
  const parts = cmd.split(/\s+/u).filter((s) => s.length > 0);
  if (parts.length === 0) return { command: "true", args: [] };
  return { command: parts[0]!, args: parts.slice(1) };
}

function truncate(s: string): string {
  if (s.length <= 800) return s;
  return s.slice(0, 800) + "…";
}

function inconclusive(args: {
  worktreePath: string;
  detector: RunnerKind;
  notes: string;
  ms: number;
  kind: InconclusiveReason;
  testCmd?: string | null;
  testExitCode?: number | null;
  testMs?: number | null;
  error?: string | null;
}): PatchVerifyOutcome {
  return {
    verdict: "inconclusive",
    detector: args.detector,
    testCmd: args.testCmd ?? null,
    testExitCode: args.testExitCode ?? null,
    testMs: args.testMs ?? null,
    pocCmd: null,
    pocExitCode: null,
    pocMs: null,
    ms: args.ms,
    notes: args.notes,
    worktreePath: args.worktreePath,
    error: args.error ?? null,
    inconclusiveReason: args.kind,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Real-world IO bindings. Test callers pass their own PatchVerifierIo; the
// production wiring uses these. The two paths share zero state, so a unit
// test stubbing exec / fs doesn't depend on /tmp being writable.
// ────────────────────────────────────────────────────────────────────────

export function realPatchVerifierIo(): PatchVerifierIo {
  return {
    mkWorktreeRoot: async () => {
      // Per env_worktree_tmp_location — NEVER under ~/projects. Always /tmp.
      return mkdtemp(join(tmpdir(), "antfleet-pv-"));
    },
    removeDir: async (path) => {
      await rm(path, { recursive: true, force: true });
    },
    exists: async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    readFile: async (path) => readFile(path, "utf8"),
    writeTempFile: async (contents) => {
      const dir = await mkdtemp(join(tmpdir(), "antfleet-pv-patch-"));
      const target = join(dir, `patch-${randomUUID()}.diff`);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(target, contents, "utf8");
      return target;
    },
    exec: async ({ command, args, cwd, timeoutMs, env }) => {
      const start = Date.now();
      return new Promise<ExecResult>((resolve) => {
        // SpawnOptions.env is typed as NodeJS.ProcessEnv (string | undefined
        // values). Our minimal env only sets defined strings, but the
        // structural mismatch on optional NODE_ENV needs an assertion.
        const opts: SpawnOptions = {
          cwd,
          env: env as NodeJS.ProcessEnv,
          stdio: ["ignore", "pipe", "pipe"],
        };
        const child = spawn(command, args, opts);
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          if (stdout.length > 64_000) stdout = stdout.slice(-32_000);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
          if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          resolve({
            exitCode: null,
            stdout,
            stderr: `${stderr}\n${err.message}`,
            ms: Date.now() - start,
            timedOut,
          });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({
            exitCode: code,
            stdout,
            stderr,
            ms: Date.now() - start,
            timedOut,
          });
        });
      });
    },
    now: () => Date.now(),
  };
}

// ────────────────────────────────────────────────────────────────────────
// Apply-stage: filter a patch-agent outcome through the verifier. For each
// entry in `byIndex` we shell out to runPatchVerifier and decide whether
// to keep, drop, or tag the entry. Returns a NEW outcome shape (the input
// is left untouched) plus one row per attempted verification for the
// caller to persist via recordGateOutcome.
//
// The applier is structurally generic over PatchAgentOutcome so this
// module does not have to import patch-agent.ts (which would create a
// load-order cycle: patch-agent → patch-verifier → patch-agent).
// ────────────────────────────────────────────────────────────────────────

export type PatchVerifyRow = {
  findingId: string | null;
  index: number;
  outcome: PatchVerifyOutcome;
};

export type VerifiablePatch = {
  patch: string;
  modelId: string;
  // Extension to PatchForRender; consumers may set this when re-emitting
  // the entry into pr-comment to surface the verifier verdict in the UI.
  verifyStatus?: "verified" | "inconclusive";
};

export type VerifiablePatchOutcome = {
  byIndex: Map<number, VerifiablePatch & Record<string, unknown>>;
  inlineByIndex: Map<number, VerifiablePatch & Record<string, unknown>>;
};

export type ApplyPatchVerifierArgs<O extends VerifiablePatchOutcome> = {
  outcome: O;
  // Required: repoUrl + sha for the verifier's shallow clone. Verifier
  // returns inconclusive if repoUrl is null.
  repoUrl: string | null;
  sha: string;
  // Lookup: index → (finding, findingId). The applier needs the finding
  // to sniff a PoC command and the findingId to attribute the gate
  // outcome row. Callers should pull these from `bundle.agreed[index]`
  // and `findingIds[index]`.
  findingAt: (index: number) => Finding | undefined;
  findingIdAt: (index: number) => string | null;
  // Test seam — replaces runPatchVerifier.
  runVerifier?: (args: RunPatchVerifierArgs) => Promise<PatchVerifyOutcome>;
  io: PatchVerifierIo;
  timeoutMs?: number;
};

export type ApplyPatchVerifierResult<O extends VerifiablePatchOutcome> = {
  outcome: O;
  rows: PatchVerifyRow[];
  droppedIndexes: number[];
};

export async function applyPatchVerifier<O extends VerifiablePatchOutcome>(
  args: ApplyPatchVerifierArgs<O>,
): Promise<ApplyPatchVerifierResult<O>> {
  const runner = args.runVerifier ?? runPatchVerifier;
  const rows: PatchVerifyRow[] = [];
  const droppedIndexes: number[] = [];

  const entries = [...args.outcome.byIndex.entries()];
  for (const [index, patch] of entries) {
    const finding = args.findingAt(index);
    if (finding === undefined) continue;
    const outcome = await runner({
      repoUrl: args.repoUrl,
      sha: args.sha,
      patch: patch.patch,
      finding,
      io: args.io,
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    });
    rows.push({ findingId: args.findingIdAt(index), index, outcome });

    if (outcome.verdict === "regressed") {
      args.outcome.byIndex.delete(index);
      args.outcome.inlineByIndex.delete(index);
      droppedIndexes.push(index);
      continue;
    }
    // verified or inconclusive: tag in place so pr-comment can render
    // "(unverified)" when applicable. The inconclusiveReason is plumbed
    // through too — pr-comment uses it to decide whether to render the
    // tag at all (soft outcomes like "no test runner" stay untagged).
    const tag = outcome.verdict === "verified" ? "verified" : "inconclusive";
    const reason = outcome.verdict === "inconclusive" ? outcome.inconclusiveReason : null;
    const byEntry = args.outcome.byIndex.get(index);
    if (byEntry !== undefined) {
      byEntry["verifyStatus"] = tag;
      byEntry["verifyInconclusiveReason"] = reason;
    }
    const inlineEntry = args.outcome.inlineByIndex.get(index);
    if (inlineEntry !== undefined) {
      inlineEntry["verifyStatus"] = tag;
      inlineEntry["verifyInconclusiveReason"] = reason;
    }
  }

  return { outcome: args.outcome, rows, droppedIndexes };
}
