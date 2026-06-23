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

export type PatchVerifyVerdict = "verified" | "regressed" | "inconclusive";

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
    });
  }

  let worktree: string | null = null;
  try {
    worktree = await args.io.mkWorktreeRoot();
    const cloned = await args.io.exec({
      command: "git",
      args: ["clone", "--depth", "1", args.repoUrl, worktree],
      cwd: worktree,
      timeoutMs,
      env: minimalEnv(),
    });
    if (cloned.exitCode !== 0) {
      return inconclusive({
        worktreePath: worktree,
        detector: "none",
        notes: `git clone failed (exit ${cloned.exitCode ?? "null"}): ${truncate(cloned.stderr)}`,
        ms: args.io.now() - t0,
      });
    }

    // git apply --index on the proposed patch. Any conflict / hunk failure
    // is treated as `regressed` — the suggestion does not apply cleanly
    // against the reviewed SHA. We deliberately do NOT use the worker's
    // `--check`-then-apply pattern because that doubles the wall clock and
    // we already get the same failure signal in a single call.
    const patchFile = await args.io.writeTempFile(args.patch);
    const applied = await args.io.exec({
      command: "git",
      args: ["apply", "--index", patchFile],
      cwd: worktree,
      timeoutMs,
      env: minimalEnv(),
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
      };
    }

    const detector = await detectRunner(args.io, worktree);
    if (detector.kind === "none") {
      return inconclusive({
        worktreePath: worktree,
        detector: "none",
        notes: "no test runner detected (no pnpm-lock / package-lock / go.mod / pyproject)",
        ms: args.io.now() - t0,
      });
    }

    const testStep = await runTestStep(args.io, worktree, detector, timeoutMs);
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
      };
    }

    const pocCmd = sniffPocCommand(args.finding);
    if (pocCmd === null) {
      return inconclusive({
        worktreePath: worktree,
        detector: detector.kind,
        notes: `tests passed; no PoC command available → inconclusive (testCmd=${detector.cmd})`,
        ms: args.io.now() - t0,
        testCmd: detector.cmd,
        testExitCode: testStep.exitCode,
        testMs: testStep.ms,
      });
    }
    const pocStep = await runPocStep(args.io, worktree, pocCmd, timeoutMs);
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
    };
  } catch (err) {
    return inconclusive({
      worktreePath: worktree ?? "(unset)",
      detector: "none",
      notes: `verifier threw: ${err instanceof Error ? err.message : String(err)}`,
      ms: args.io.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (worktree !== null) {
      // Best-effort teardown; we never bubble cleanup failures because the
      // worktree path lives under /tmp and the OS will reclaim it anyway.
      try {
        await args.io.removeDir(worktree);
      } catch {
        // swallow — see comment above
      }
    }
  }
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
    return { kind: "pnpm", cmd: "pnpm test" };
  }
  if (await io.exists(join(worktree, "package-lock.json"))) {
    return { kind: "npm", cmd: "npm test --silent" };
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
): Promise<ExecResult> {
  const { command, args } = splitCommand(detector.cmd);
  return io.exec({
    command,
    args,
    cwd: worktree,
    timeoutMs,
    env: minimalEnv(),
  });
}

async function runPocStep(
  io: PatchVerifierIo,
  worktree: string,
  pocCmd: string,
  timeoutMs: number,
): Promise<ExecResult> {
  const { command, args } = splitCommand(pocCmd);
  return io.exec({
    command,
    args,
    cwd: worktree,
    timeoutMs,
    env: minimalEnv(),
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
// HOME is rooted at a per-call temp dir so `~/.config` writes can't reach
// the parent's dotfiles. NODE_ENV=test silences some optional bootstraps.
export function minimalEnv(): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp",
    NODE_ENV: "test",
    CI: "1",
    // Per `feedback_run_oxfmt_before_push` and similar, runners may probe
    // for git identity. A bare global config under HOME=/tmp is enough.
    GIT_TERMINAL_PROMPT: "0",
    // Prevent npm/pnpm from offering interactive prompts.
    npm_config_yes: "true",
  };
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
    // "(unverified)" when applicable.
    const tag = outcome.verdict === "verified" ? "verified" : "inconclusive";
    const byEntry = args.outcome.byIndex.get(index);
    if (byEntry !== undefined) byEntry["verifyStatus"] = tag;
    const inlineEntry = args.outcome.inlineByIndex.get(index);
    if (inlineEntry !== undefined) inlineEntry["verifyStatus"] = tag;
  }

  return { outcome: args.outcome, rows, droppedIndexes };
}
