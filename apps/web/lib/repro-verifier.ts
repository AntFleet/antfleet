// Repro-execution verifier (issue #133, Build 2b) — the prove-the-bug verifier.
//
// Runs AFTER Build 2a's generateReproTest produces a ReproTestSuggestion and
// BEFORE a finding is treated as machine-proven. Where runPatchVerifier
// ASSUMES the finding's PoC reproduced pre-patch (it only re-runs the PoC
// post-patch and infers), this verifier PROVES it by running the generated
// repro TWICE against the same worktree:
//
//   1. Clone + checkout the reviewed SHA (reuses patch-verifier's setup steps).
//   2. Write the generated repro file into the worktree — SAFELY (symlink-safe,
//      no-clobber, never under .git, restricted mode, inside the worktree).
//   3. Run repro.cmd PRE-patch. REQUIRE exit 0 (== bug reproduces, per the
//      exit-0-on-unpatched convention repro-generation.ts authors to). If it
//      does NOT exit 0 we could not prove the bug → inconclusive, NEVER
//      verified.
//   4. git apply the patch.
//      (Runner detection + the offline-deps probe/install actually happen just
//      BEFORE step 3, so both repro observations share the same dependency
//      state — see the dep-prefetch note below.)
//   5. Run the auto-detected test suite. A post-patch test failure → regressed.
//   6. Run repro.cmd POST-patch. REQUIRE exit non-zero (== bug fixed). If it
//      still exits 0 the patch did not close the bug → regressed. If it exits
//      non-zero → verified, with BOTH observations (pre 0, post non-zero)
//      recorded on the outcome so the verdict is a genuine proof.
//
// SECURITY — this executes MODEL-GENERATED code:
//   - The whole path is gated behind ANTFLEET_REPRO_EXEC (default OFF). When
//     OFF, no model cmd is ever spawned — we return inconclusive
//     `repro_exec_disabled` immediately.
//   - Executing model code is only safe under the disposable-CI-runner
//     containment model (Build 2b-2) with minimalEnv stripping EVERY secret
//     from the subprocess. This module reuses patch-verifier's minimalEnv,
//     /tmp-only worktree, wall-clock SIGKILL timeout, and finally teardown
//     verbatim — it does NOT reinvent or weaken any of them.
//   - repro.cmd is re-validated here (defense in depth) through the SAME
//     matchesPocCommandAllowlist + a \p{Cc} control-char reject before exec,
//     and is spawned argv-direct (never through a shell).
//   - The repro file write is symlink-safe (lstat no-follow on every path
//     component), no-clobber, refuses any path under .git, size-capped, and is
//     confined to the worktree via a resolve + startsWith check.
//
// CONTAINMENT IS BUILD 2b-2's JOB (do NOT enable ANTFLEET_REPRO_EXEC without it).
// A 3-lane external audit (2026-07-11) confirmed the process-level hardening here
// (minimalEnv secret-strip on BOTH spawns, /tmp worktree, timeout, teardown) is
// NOT a security boundary against attacker-authored code and MUST be paired with
// the disposable-CI-runner model before the flag is turned on. Explicitly
// out-of-scope for THIS module and deferred to 2b-2's runner:
//   - separate PID/user/mount namespaces + restricted procfs (a same-UID payload
//     can otherwise read the launcher's /proc/<ppid>/environ),
//   - network-egress / cloud-metadata denial at the network layer (minimalEnv's
//     IMDS vars only stop cooperative SDKs),
//   - whole-process-tree / cgroup teardown (the timeout SIGKILLs only the direct
//     child; a daemonized grandchild survives),
//   - openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS) to fully close the parent-dir
//     symlink TOCTOU (the leaf is already O_EXCL/`wx` no-clobber safe).
// The verdict is also an UNTRUSTED differential: the repro is model-authored, so
// a `verified` proves "exit 0 pre → non-zero post under the test suite", not a
// cryptographic guarantee the patch is the cause. It is a strictly stronger
// signal than the assume-reproduction PoC path, contained to a suggestion tag.
//
// DEP-PREFETCH (opt-in, ANTFLEET_REPRO_DEP_PREFETCH, default OFF): a JS suite
// with no committed node_modules cannot run offline. When enabled, the deps are
// installed ONCE — before the pre-repro observation — in a network-enabled,
// SECRET-FREE, --ignore-scripts, resource-capped container mounted only the rw
// worktree (see maybeInstallDeps + the batch's installExec). This is the ONE
// exception to "everything runs --network none": it runs no attacker code
// (scripts ignored), holds no secret, and its output (node_modules) is consumed
// by the OFFLINE suite, so a `verified` still means "the offline suite passed"
// — recorded via depPrefetched for honest provenance. Hardened per codex #164.
//
// runPatchVerifier is UNCHANGED and independent — its PoC path does not run
// through here.

import type { Finding } from "./review-types";
import type { ReproTestSuggestion } from "@antfleet/cli/types";
import { isReproExecEnabled } from "./daybreak-gates-env";
import { isSafeReproPath, REPRO_FILE_MAX_BYTES } from "./repro-generation";
import {
  detectRunner,
  isSafeRepoUrl,
  isSafeSha,
  matchesPocCommandAllowlist,
  minimalEnv,
  runSetupSteps,
  runTestStep,
  splitCommand,
  truncate,
  type ExecArgs,
  type ExecResult,
  type PatchVerifierIo,
  type PatchVerifyOutcome,
  type RunnerKind,
} from "./patch-verifier";

const DEFAULT_TIMEOUT_MS = 120_000;

// Restrictive mode for the written repro file: owner read/write only. The file
// is executed indirectly (interpreted by an allowlisted runner), never given
// the execute bit, and never made group/other readable.
const REPRO_FILE_MODE = 0o600;

// Control characters (newline, CR, tab, NUL, …). A repro run command is always
// a single line; a control char is a smuggling attempt (a second line the
// allowlisted prefix would otherwise carry to the runner). Unicode property
// escape — oxlint's no-control-regex forbids literal control chars in a regex.
const CONTROL_CHAR = /\p{Cc}/u;

// The repro verifier extends PatchVerifierIo with two write-side seams the
// existing verifier never needed: an lstat-based symlink probe used to walk
// every path COMPONENT before writing (not just the leaf, unlike the
// evidence-read `isSymlink`), and a mode-restricted file writer. Both are
// injectable so the unit tests stay hermetic; production wiring binds them to
// real fs calls in realReproVerifierIo.
export type ReproVerifierIo = PatchVerifierIo & {
  // lstat WITHOUT following symlinks: returns true iff `path` itself is a
  // symlink. Used on every parent directory AND the target before writing.
  lstatIsSymlink: (path: string) => Promise<boolean>;
  // Write `contents` to `path` with `mode`, refusing to overwrite an existing
  // file (no-clobber — implemented with the `wx` flag in prod). Throws on
  // clobber or any other write error.
  writeFileNoClobber: (path: string, contents: string, mode: number) => Promise<void>;
  // OPTIONAL network-enabled exec, used ONLY for the dep-prefetch install
  // (npm ci / pnpm install --ignore-scripts). When absent — hermetic tests, or
  // the ANTFLEET_REPRO_DEP_PREFETCH flag OFF — a JS suite with missing offline
  // deps stays `deps_unavailable`. The batch wires this to a `--network bridge`,
  // SECRET-FREE, resource-limited container mounted ONLY the rw worktree (no
  // mirror / patch control dir). Its output is node_modules; every
  // verdict-affecting step still runs through offline `exec`.
  execInstall?: (args: ExecArgs) => Promise<ExecResult>;
};

// Git clone SOURCE — a discriminated union over the two clone modes. Folded
// from the former (repoUrl + localMirrorDir) pair now that a real caller (the
// #145 exec phase) drives the offline mode, so a spec can no longer set both
// and the mode is explicit at the type level:
//   - online:  clone the http(s) `url`. url null → inconclusive `no_repo_url`
//     (no source to prove against, mirroring runPatchVerifier), e.g. a
//     serverless / no-source finding.
//   - offline: clone from `mirrorDir`, a local bare git mirror the TRUSTED
//     fetch phase pre-materialised, so the verifier needs NO network — which is
//     what lets the exec sandbox run under `--network none`. NOTE: that
//     container-level flag (Build 2b-2 v2's job), NOT this module, is what
//     actually denies the model repro all network; minimalEnv only strips
//     secrets from the subprocess env.
//
// PART-3 MIRROR CONTRACT (offline) — the fetch phase MUST honor these, this
// module trusts them: `mirrorDir` is validated defensively (isSafeLocalMirrorDir
// + existence + a LEAF symlink check) even though it is our own path and never
// carries model-controlled input; the mirror is disposable / mounted read-only
// under a fixed trusted root (no repro may mutate it for a later call; the
// leaf-only lstat here does NOT catch a symlinked ANCESTOR — a read-only trusted
// root is what closes that), self-contained (no partial-clone promisor /
// external alternates), and CONTAINS the reviewed SHA pinned under a durable ref
// (e.g. refs/pull/<n>/head or refs/pinned/<sha>) so it survives GC and is
// fetchable under any git protocol version (protocol v0 rejects an unadvertised
// raw SHA).
export type ReproRepoSource =
  | { kind: "online"; url: string | null } // url null → no_repo_url (serverless/no-source)
  | { kind: "offline"; mirrorDir: string }; // clone from a local bare mirror (no network)

export type RunReproVerifierArgs = {
  repoSource: ReproRepoSource;
  sha: string;
  patch: string;
  repro: ReproTestSuggestion;
  finding: Finding;
  // Default 120s per child process; SIGKILL on timeout.
  timeoutMs?: number;
  io: ReproVerifierIo;
};

export async function runReproVerifier(args: RunReproVerifierArgs): Promise<PatchVerifyOutcome> {
  const t0 = args.io.now();
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // HARD GATE. When the flag is OFF we must not spawn any model-generated
  // command. Return before touching the worktree, the network, or the cmd —
  // there is nothing to clean up because nothing ran.
  if (!isReproExecEnabled()) {
    return reproInconclusive({
      worktreePath: "(repro-exec-disabled)",
      notes: "ANTFLEET_REPRO_EXEC is disabled; repro-execution verifier skipped",
      ms: args.io.now() - t0,
      kind: "repro_exec_disabled",
    });
  }

  // Model DECLINE: cmd === null means Build 2a could not author a runnable
  // repro. No proof is possible; do not claim verified.
  if (args.repro.cmd === null) {
    return reproInconclusive({
      worktreePath: "(no-repro)",
      notes: `model declined to author a repro${
        args.repro.rationale !== null ? `: ${args.repro.rationale}` : ""
      }`,
      ms: args.io.now() - t0,
      kind: "no_repro",
    });
  }
  const reproCmd = args.repro.cmd;

  // Defense in depth: the cmd was allowlist + control-char validated at
  // generation time, but re-validate here before exec because THIS is the call
  // site that actually spawns it. Reject any control character first (a single
  // line always), then require an allowlisted runner prefix with no shell
  // metacharacter. Never routed through a shell — spawned argv-direct below.
  if (CONTROL_CHAR.test(reproCmd) || matchesPocCommandAllowlist(reproCmd) === null) {
    return reproInconclusive({
      worktreePath: "(invalid-repro-cmd)",
      notes: "repro cmd failed the allowlist / control-char gate; refusing to execute",
      ms: args.io.now() - t0,
      kind: "invalid_input",
    });
  }

  // Resolve + validate the git clone SOURCE by switching on the repoSource
  // discriminant. OFFLINE clones from a local bare mirror the trusted fetch
  // phase pre-materialised, so the exec sandbox needs NO network. ONLINE clones
  // the http(s) url. Either way the source goes straight into git argv, so
  // validate its shape (reject a `--upload-pack=` URL, a `-`-leading path, or a
  // traversal) BEFORE spawning git; the `--` separator threaded after each
  // subcommand is the second layer. The resolved mirrorDir (offline only) is
  // captured so the in-try existence + leaf-symlink check can re-probe it.
  let cloneSource: string;
  let mirrorDir: string | null = null;
  if (args.repoSource.kind === "offline") {
    if (!isSafeLocalMirrorDir(args.repoSource.mirrorDir)) {
      return reproInconclusive({
        worktreePath: "(invalid-mirror-dir)",
        notes:
          "repro-verifier rejected unsafe offline mirrorDir (need an absolute, traversal-free path)",
        ms: args.io.now() - t0,
        kind: "invalid_input",
      });
    }
    mirrorDir = args.repoSource.mirrorDir;
    cloneSource = args.repoSource.mirrorDir;
  } else {
    if (args.repoSource.url === null) {
      return reproInconclusive({
        worktreePath: "(no-repo-url)",
        notes:
          "repro-verifier requires an online url (or an offline mirror) to clone from; skipping",
        ms: args.io.now() - t0,
        kind: "no_repo_url",
      });
    }
    if (!isSafeRepoUrl(args.repoSource.url)) {
      return reproInconclusive({
        worktreePath: "(invalid-repo-url)",
        notes: "repro-verifier rejected unsafe repoUrl shape",
        ms: args.io.now() - t0,
        kind: "invalid_input",
      });
    }
    cloneSource = args.repoSource.url;
  }
  if (!isSafeSha(args.sha)) {
    return reproInconclusive({
      worktreePath: "(invalid-sha)",
      notes: "repro-verifier rejected non-hex sha",
      ms: args.io.now() - t0,
      kind: "invalid_input",
    });
  }

  let worktree: string | null = null;
  let homeDir: string | null = null;
  try {
    worktree = await args.io.mkWorktreeRoot();
    // Per-call HOME dir — see the runPatchVerifier comment: hardcoding HOME
    // would let a planted /tmp/.gitconfig / .npmrc trigger command execution
    // on the next call. Created here, removed in the same finally.
    homeDir = await args.io.mkWorktreeRoot();
    const sandboxEnv = minimalEnv(homeDir);

    // OFFLINE: the mirror dir must EXIST and NOT be a symlink before we clone
    // from it — a symlinked mirror could redirect the clone out of the intended
    // tree. Checked here (inside try) so an io throw is caught as `exception`
    // rather than becoming an unhandled rejection.
    if (mirrorDir !== null) {
      if (!(await args.io.exists(mirrorDir)) || (await args.io.lstatIsSymlink(mirrorDir))) {
        return reproInconclusive({
          worktreePath: worktree,
          notes: `offline mirror dir '${mirrorDir}' is missing or a symlink; refusing to clone`,
          ms: args.io.now() - t0,
          kind: "invalid_input",
        });
      }
    }

    // Same clone/checkout sequence runPatchVerifier uses (init → remote add →
    // fetch by SHA → checkout FETCH_HEAD), but from the resolved cloneSource
    // (a local mirror OFFLINE, or the http(s) repoUrl ONLINE) so both verifiers
    // land on the same reviewed SHA the same way.
    const initialised = await runSetupSteps(
      args.io,
      worktree,
      [
        { command: "git", args: ["init", "--quiet", "--", worktree] },
        {
          command: "git",
          args: ["-C", worktree, "remote", "add", "origin", "--", cloneSource],
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
      return reproInconclusive({
        worktreePath: worktree,
        notes: initialised.error,
        ms: args.io.now() - t0,
        kind: "setup_failed",
      });
    }

    // Detect the runner and provision deps BEFORE any repro observation. Both the
    // pre- and post-patch repro runs MUST see the SAME dependency state: if deps
    // (and any install side-effects) appeared only between the observations, they
    // — not the patch — could flip the post-repro and mint a false `verified`
    // (codex audit #164, forge lane). Detection + dep-prefetch therefore run here,
    // on the clean pre-patch tree, so the ONLY thing that differs between the two
    // observations is the patch itself.
    const detector = await detectRunner(args.io, worktree);
    if (detector.kind === "none") {
      // A `verified` proof asserts the patch did not break the build, so a runner
      // is REQUIRED. (Audit 2026-07-11: `verified` was reachable with kind none.)
      return reproInconclusive({
        worktreePath: worktree,
        notes:
          "no test runner detected — cannot confirm non-regression; " +
          "a repro differential alone is not a verified proof",
        ms: args.io.now() - t0,
        kind: "no_runner",
        reproCmd,
      });
    }

    // The suite + repro run offline (`--network none`), so a suite whose deps were
    // never committed cannot run: the runner exits non-zero on command/module not
    // found, which the regressed branch below would misread as "the patch broke
    // the tests". Probe; if deps are missing, try the dep-prefetch install
    // (network, secret-free, --ignore-scripts) — BEFORE the pre-repro so both
    // observations share the installed state. A failed/absent install stays the
    // honest `deps_unavailable`; it can never mint a verdict.
    let depPrefetched = false;
    const missingDeps = await probeOfflineDeps(args.io, worktree, detector.kind);
    if (missingDeps !== null) {
      const prefetch = await maybeInstallDeps(
        args.io,
        worktree,
        detector.kind,
        timeoutMs,
        sandboxEnv,
      );
      if (!prefetch.ok) {
        return reproInconclusive({
          worktreePath: worktree,
          detector: detector.kind,
          notes: `suite deps unavailable offline — ${missingDeps}${prefetch.notes}; cannot run tests, cannot decide`,
          ms: args.io.now() - t0,
          kind: "deps_unavailable",
          reproCmd,
        });
      }
      depPrefetched = true;
    }

    // Write the generated repro file SAFELY, if one was provided. A bare-curl
    // repro carries file=null and needs no write. Capture the resolved absolute
    // path so we can remove it before the test suite (so the runner cannot
    // auto-collect it) and re-materialise it before the post-patch run.
    let writtenReproPath: string | null = null;
    if (args.repro.file !== null) {
      const write = await safeWriteReproFile(args.io, worktree, args.repro.file);
      if (!write.ok) {
        return reproInconclusive({
          worktreePath: worktree,
          notes: write.notes,
          ms: args.io.now() - t0,
          kind: write.kind,
        });
      }
      writtenReproPath = write.absolutePath;
    }

    // ── Observation 1: run the repro PRE-patch. Require exit 0 == the bug
    // reproduces against the unpatched source. If it does not exit 0 we have
    // NOT proven the bug — return inconclusive, never verified. This is the
    // whole difference from the assume-reproduction PoC path.
    const preStep = await runReproStep(args.io, worktree, reproCmd, timeoutMs, sandboxEnv);
    if (preStep.timedOut) {
      return reproInconclusive({
        worktreePath: worktree,
        notes: `repro killed after ${timeoutMs}ms pre-patch — cannot prove the bug`,
        ms: args.io.now() - t0,
        kind: "repro_timeout",
        reproCmd,
        reproPreMs: preStep.ms,
      });
    }
    if (preStep.exitCode !== 0) {
      return reproInconclusive({
        worktreePath: worktree,
        notes: `repro did NOT exit 0 pre-patch (exit ${
          preStep.exitCode ?? "null"
        }) → bug not reproduced; not verified: ${truncate(preStep.stderr)}`,
        ms: args.io.now() - t0,
        kind: "repro_not_reproducing",
        reproCmd,
        reproPreExitCode: preStep.exitCode,
        reproPreMs: preStep.ms,
      });
    }

    // Apply the patch. Unlike runPatchVerifier (which treats an apply failure
    // as `regressed`), the repro path reports it as inconclusive
    // `patch_apply_failed`: we proved the bug but could not evaluate this
    // patch, which is not a regression of the patch's own behavior.
    const patchFile = await args.io.writeTempFile(args.patch);
    // --unidiff-zero: the patch adapter emits zero-context hunks, which stock
    // `git apply` rejects unless they touch the beginning/end of the file.
    const applied = await args.io.exec({
      command: "git",
      args: ["-C", worktree, "apply", "--index", "--unidiff-zero", "--", patchFile],
      cwd: worktree,
      timeoutMs,
      env: sandboxEnv,
    });
    if (applied.exitCode !== 0) {
      return reproInconclusive({
        worktreePath: worktree,
        notes: `git apply failed (exit ${applied.exitCode ?? "null"}): ${truncate(applied.stderr)}`,
        ms: args.io.now() - t0,
        kind: "patch_apply_failed",
        reproCmd,
        reproPreExitCode: preStep.exitCode,
        reproPreMs: preStep.ms,
      });
    }

    // Post-patch test suite. The runner + deps were resolved BEFORE the pre-repro
    // (see above), so both observations share the same dependency state and only
    // the patch differs between them.
    // Remove the written repro BEFORE the suite so the runner cannot auto-collect
    // it (pytest discovers `*_test.py`, etc.). The repro is DESIGNED to fail
    // post-patch; letting the suite execute it would flip a correct patch to a
    // false `regressed`. We re-materialise it from the SAME trusted stored
    // contents before Observation 2 — which also RESETS any self-modification the
    // pre-patch run made to the file. (Audit 2026-07-11: pytest self-collection +
    // shared-mutable-state.)
    if (writtenReproPath !== null) {
      try {
        await args.io.removeDir(writtenReproPath);
      } catch {
        // best effort — if it survives, the suite may collect it; the no-clobber
        // re-materialise below then fails closed (unsafe_repro_write).
      }
    }

    const testStep = await runTestStep(args.io, worktree, detector, timeoutMs, sandboxEnv);
    const testCmd: string = detector.cmd;
    const testMs: number = testStep.ms;
    if (testStep.timedOut) {
      return reproInconclusive({
        worktreePath: worktree,
        detector: detector.kind,
        notes: `tests killed after ${timeoutMs}ms — verifier cannot decide (testCmd=${detector.cmd})`,
        ms: args.io.now() - t0,
        kind: "test_timeout",
        testCmd,
        testMs,
        reproCmd,
        reproPreExitCode: preStep.exitCode,
        reproPreMs: preStep.ms,
      });
    }
    // A null test exit that did NOT time out (signal / OOM / missing runner exe)
    // is infrastructure uncertainty, NOT evidence the patch broke tests. Do not
    // drop a good patch — return inconclusive rather than regressed. (Audit
    // 2026-07-11: abnormal test termination classified as regressed.)
    if (typeof testStep.exitCode !== "number") {
      return reproInconclusive({
        worktreePath: worktree,
        detector: detector.kind,
        notes: "post-patch tests produced no exit code (abnormal termination) — cannot decide",
        ms: args.io.now() - t0,
        kind: "abnormal_exit",
        testCmd,
        testMs,
        reproCmd,
        reproPreExitCode: preStep.exitCode,
        reproPreMs: preStep.ms,
      });
    }
    const testExitCode: number = testStep.exitCode;
    // Exit 127 (command not found) / 126 (not executable) from the runner means
    // the test binary or a toolchain dep is ABSENT — an incomplete dep tree, not
    // a patch regression. This is the residual the shape-only re-probe can't see
    // (e.g. `.npmrc omit=dev` → node_modules exists but the test framework is
    // missing). Fail closed to `deps_unavailable`, never `regressed` (codex #164).
    if (testExitCode === 127 || testExitCode === 126) {
      return reproInconclusive({
        worktreePath: worktree,
        detector: detector.kind,
        notes: `test runner not executable (exit ${testExitCode}) — deps incomplete offline, cannot decide: ${truncate(testStep.stderr)}`,
        ms: args.io.now() - t0,
        kind: "deps_unavailable",
        testCmd,
        testExitCode,
        testMs,
        reproCmd,
        reproPreExitCode: preStep.exitCode,
        reproPreMs: preStep.ms,
      });
    }
    if (testExitCode !== 0) {
      return {
        verdict: "regressed",
        detector: detector.kind,
        testCmd,
        testExitCode,
        testMs,
        pocCmd: null,
        pocExitCode: null,
        pocMs: null,
        ms: args.io.now() - t0,
        notes: `tests failed after patch (exit ${testExitCode}): ${truncate(testStep.stderr)}`,
        worktreePath: worktree,
        error: null,
        inconclusiveReason: null,
        depPrefetched,
        reproCmd,
        reproPreExitCode: preStep.exitCode,
        reproPostExitCode: null,
        reproPreMs: preStep.ms,
        reproPostMs: null,
      };
    }

    // Re-materialise the repro for Observation 2 (removed before the suite).
    // safeWriteReproFile re-runs the FULL symlink / clobber / size gate, so if
    // the just-run test suite planted anything at the path we fail closed.
    if (writtenReproPath !== null && args.repro.file !== null) {
      const rewrite = await safeWriteReproFile(args.io, worktree, args.repro.file);
      if (!rewrite.ok) {
        return reproInconclusive({
          worktreePath: worktree,
          detector: detector.kind,
          notes: `could not re-materialise repro for the post-patch run: ${rewrite.notes}`,
          ms: args.io.now() - t0,
          kind: rewrite.kind,
          testCmd,
          testExitCode,
          testMs,
          reproCmd,
          reproPreExitCode: preStep.exitCode,
          reproPreMs: preStep.ms,
        });
      }
    }

    // ── Observation 2: run the repro POST-patch. Require a CONCRETE non-zero
    // exit == the bug is fixed. A timeout is inconclusive; a still-0 exit means
    // the patch did not close the bug → regressed; a null exit (signal / spawn
    // failure that did NOT time out) is NOT proof → inconclusive, never verified.
    const postStep = await runReproStep(args.io, worktree, reproCmd, timeoutMs, sandboxEnv);
    if (postStep.timedOut) {
      return reproInconclusive({
        worktreePath: worktree,
        detector: detector.kind,
        notes: `repro killed after ${timeoutMs}ms post-patch — cannot confirm the fix`,
        ms: args.io.now() - t0,
        kind: "repro_timeout",
        testCmd,
        testExitCode,
        testMs,
        reproCmd,
        reproPreExitCode: preStep.exitCode,
        reproPreMs: preStep.ms,
        reproPostMs: postStep.ms,
      });
    }
    if (postStep.exitCode === 0) {
      return {
        verdict: "regressed",
        detector: detector.kind,
        testCmd,
        testExitCode,
        testMs,
        pocCmd: null,
        pocExitCode: null,
        pocMs: null,
        ms: args.io.now() - t0,
        notes: `repro still exits 0 post-patch → patch did NOT close the bug (proved reproducing pre-patch)`,
        worktreePath: worktree,
        error: null,
        inconclusiveReason: null,
        reproCmd,
        reproPreExitCode: preStep.exitCode,
        reproPostExitCode: postStep.exitCode,
        reproPreMs: preStep.ms,
        reproPostMs: postStep.ms,
      };
    }
    // Non-timeout null post-patch exit: the repro produced NO exit code, which is
    // not proof the bug is fixed. Refuse to claim verified. (Audit 2026-07-11:
    // `exitCode: null` post-patch was recorded as verified.)
    if (typeof postStep.exitCode !== "number") {
      return reproInconclusive({
        worktreePath: worktree,
        detector: detector.kind,
        notes:
          "repro produced no exit code post-patch (abnormal termination) — " +
          "cannot confirm the fix; not verified",
        ms: args.io.now() - t0,
        kind: "abnormal_exit",
        testCmd,
        testExitCode,
        testMs,
        reproCmd,
        reproPreExitCode: preStep.exitCode,
        reproPreMs: preStep.ms,
        reproPostMs: postStep.ms,
      });
    }
    return {
      verdict: "verified",
      detector: detector.kind,
      testCmd,
      testExitCode,
      testMs,
      pocCmd: null,
      pocExitCode: null,
      pocMs: null,
      ms: args.io.now() - t0,
      notes: `PROVED: repro exited 0 pre-patch (bug reproduced) and exit ${postStep.exitCode} post-patch (bug fixed); test suite passed${depPrefetched ? " (deps network-prefetched)" : ""}`,
      worktreePath: worktree,
      error: null,
      inconclusiveReason: null,
      depPrefetched,
      reproCmd,
      reproPreExitCode: preStep.exitCode,
      reproPostExitCode: postStep.exitCode,
      reproPreMs: preStep.ms,
      reproPostMs: postStep.ms,
    };
  } catch (err) {
    return reproInconclusive({
      worktreePath: worktree ?? "(unset)",
      notes: `repro-verifier threw: ${err instanceof Error ? err.message : String(err)}`,
      ms: args.io.now() - t0,
      error: err instanceof Error ? err.message : String(err),
      kind: "exception",
    });
  } finally {
    // Tear down BOTH the worktree and the per-call HOME dir — best effort,
    // never bubble cleanup failures. Same posture as runPatchVerifier.
    for (const dir of [worktree, homeDir]) {
      if (dir === null) continue;
      try {
        await args.io.removeDir(dir);
      } catch {
        // swallow — the OS reclaims /tmp eventually
      }
    }
  }
}

// Run the model-generated repro cmd through the same spawn + minimalEnv +
// timeout path the existing PoC step uses. The cmd is split argv-direct (never
// a shell) and was already allowlist + control-char validated by the caller.
async function runReproStep(
  io: PatchVerifierIo,
  worktree: string,
  reproCmd: string,
  timeoutMs: number,
  env: Record<string, string>,
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
}> {
  const { command, args } = splitCommand(reproCmd);
  return io.exec({
    command,
    args,
    cwd: worktree,
    timeoutMs,
    env,
  });
}

// Hard cap on a manifest the probe will read. No legitimate go.mod /
// requirements.txt / pyproject.toml approaches this; a hostile worktree can
// commit a symlink to /dev/zero or a multi-GB file, and an unbounded read
// would run on the TRUSTED orchestrator (codex review #163, HIGH).
const MANIFEST_MAX_BYTES = 262_144; // 256 KiB

// Symlink-refusing, size-capped manifest read. Returns null when the file is
// a symlink, oversized, or unreadable — the caller treats null as "cannot
// know" → deps unavailable → inconclusive (downgrade-only, fail closed).
// The isSymlink/statSize seams are optional on PatchVerifierIo (hermetic
// tests omit them); production wiring binds both, so the guards are always
// live where hostile content is.
async function safeReadManifest(io: PatchVerifierIo, path: string): Promise<string | null> {
  try {
    if (io.isSymlink !== undefined && (await io.isSymlink(path))) return null;
    if (io.statSize !== undefined && (await io.statSize(path)) > MANIFEST_MAX_BYTES) return null;
    return await io.readFile(path);
  } catch {
    return null;
  }
}

// exists + (when the seam is bound) lstat-isDirectory. A hostile repo can
// commit a FILE named node_modules; bare exists() would pass it and the suite
// would then fail command-not-found → false regressed. lstat also refuses a
// symlink-to-directory.
async function isRealDir(io: PatchVerifierIo, path: string): Promise<boolean> {
  if (!(await io.exists(path))) return false;
  if (io.isDirectory !== undefined) {
    try {
      return await io.isDirectory(path);
    } catch {
      return false;
    }
  }
  return true;
}

// Strip full-line and trailing `#` comments from manifest text. Naive about
// `#` inside quoted strings, which no real dep spec contains — and every
// misjudgment here only downgrades a verdict to inconclusive, never mints one.
function stripHashComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const i = line.indexOf("#");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

// The install command per JS runner. Hardened per the codex audit (#164):
//   --ignore-scripts   the install runs WITH network, so disabling lifecycle
//                      scripts means NO attacker-authored code executes during
//                      the networked step — only npm/pnpm resolving+extracting
//                      the repo's own lockfile. This is the containment lever
//                      that makes bridge networking acceptable. TRADE-OFF: a
//                      suite needing a native/postinstall-built dep (node-gyp,
//                      esbuild's binary fetch) won't have it → the offline suite
//                      exits 127 → `deps_unavailable` (honest). Pure-JS suites
//                      (vitest/jest/tsx without native deps) are the v1 target.
//   dev deps forced    test frameworks live in devDependencies; a committed
//                      `.npmrc omit=dev` / `--prod` config would otherwise yield
//                      a node_modules missing the runner → false regressed.
// `--frozen-lockfile` / `ci` pin to the repo's OWN committed lockfile (no
// mutation, reproducible). Only pnpm/npm are prefetchable here: go has no
// toolchain in the image and pip is deferred.
export function installCommandFor(kind: RunnerKind): { command: string; args: string[] } | null {
  if (kind === "pnpm") {
    return {
      command: "pnpm",
      args: ["install", "--frozen-lockfile", "--prod=false", "--ignore-scripts"],
    };
  }
  if (kind === "npm") return { command: "npm", args: ["ci", "--include=dev", "--ignore-scripts"] };
  return null;
}

// Populate node_modules via the network-enabled install seam, then re-probe.
// SECURITY (hardened per codex audit #164):
//   - `--ignore-scripts` (in installCommandFor) means NO attacker-authored code
//     runs during the networked step — only npm/pnpm resolving the repo's own
//     lockfile. That is what makes bridge networking tolerable here.
//   - the install container carries NO secrets (the exec job holds none) and is
//     mounted ONLY the rw worktree — NOT the bare mirror or the patch control
//     dir (the batch strips those from the networked container), so a hostile
//     package cannot exfiltrate the unpublished patch or private source.
//   - it runs in its OWN `--rm`, resource-limited container destroyed before the
//     offline suite container starts, so nothing survives to serve the suite.
//   - deps are installed BEFORE the pre-repro observation (see the caller), so
//     both observations share the same state — the install cannot skew the
//     pre/post differential. Its output is node_modules only; the suite + repro
//     still run offline, so a `verified` remains "the offline suite passed".
// A null seam (flag OFF / hermetic test) or any failure returns ok:false → the
// caller keeps the honest `deps_unavailable`; the seam can never mint a verdict.
async function maybeInstallDeps(
  io: ReproVerifierIo,
  worktree: string,
  kind: RunnerKind,
  timeoutMs: number,
  env: Record<string, string>,
): Promise<{ ok: boolean; notes: string }> {
  if (io.execInstall === undefined) return { ok: false, notes: " (dep-prefetch disabled)" };
  const install = installCommandFor(kind);
  if (install === null) return { ok: false, notes: " (no offline-safe install for this runner)" };

  const r = await io.execInstall({
    command: install.command,
    args: install.args,
    cwd: worktree,
    timeoutMs,
    env,
  });
  if (r.timedOut) return { ok: false, notes: ` (dep install timed out after ${timeoutMs}ms)` };
  if (r.exitCode !== 0) {
    return {
      ok: false,
      notes: ` (dep install failed exit ${r.exitCode ?? "null"}: ${truncate(r.stderr)})`,
    };
  }
  // An install that reports success but produced no usable deps must NOT fall
  // through to a suite run (which would then fail command-not-found → false
  // regressed). Re-run the SAME deterministic probe: only a genuine
  // node_modules directory lets us proceed.
  const stillMissing = await probeOfflineDeps(io, worktree, kind);
  if (stillMissing !== null) {
    return { ok: false, notes: ` (deps still unavailable after install: ${stillMissing})` };
  }
  return { ok: true, notes: "" };
}

// Deterministic pre-flight for the offline (`--network none`) suite run: can
// the detected runner's dependencies exist in this worktree at all? Returns a
// human-readable reason when they cannot (→ inconclusive `deps_unavailable`),
// or null when the suite is worth attempting. Worktree content is untrusted;
// every branch here only DOWNGRADES a would-be `regressed` to inconclusive —
// it can never mint a `verified` (that still requires the suite to run and
// pass) — so a hostile repo gains nothing by gaming the probe.
export async function probeOfflineDeps(
  io: PatchVerifierIo,
  worktree: string,
  kind: RunnerKind,
): Promise<string | null> {
  const p = (rel: string) => `${worktree}/${rel}`;
  if (kind === "pnpm" || kind === "npm") {
    // A lockfile got the runner detected, but the suite invokes binaries from
    // node_modules/.bin — absent an install (impossible offline), it cannot
    // run. Accepted narrowing: a `"test": "node --test"` stdlib-only suite
    // needs no node_modules and is skipped too — that is an inconclusive we
    // can live with, not a wrong regressed.
    return (await isRealDir(io, p("node_modules"))) ? null : "node_modules is not present";
  }
  if (kind === "go") {
    // The exec image ships no go toolchain yet (.github/repro-exec.Dockerfile
    // documents it as a follow-up), so ANY go suite dies command-not-found —
    // the exact false-regressed this probe exists to prevent (codex review
    // #163, HIGH). Unconditional until go lands in the image; then restore
    // the vendor-tree / require-free-go.mod check.
    return "go toolchain is not in the exec image (Dockerfile follow-up)";
  }
  if (kind === "pytest") {
    // The exec image ships pytest but no project site-packages. Declared deps
    // therefore cannot import; only a stdlib-only project can run offline.
    if (await io.exists(p("requirements.txt"))) {
      const reqs = await safeReadManifest(io, p("requirements.txt"));
      if (reqs === null) return "requirements.txt is unreadable or unsafe";
      const hasDep = stripHashComments(reqs)
        .split("\n")
        .some((l) => l.trim().length > 0);
      if (hasDep) return "requirements.txt declares dependencies";
    }
    if (await io.exists(p("pyproject.toml"))) {
      const py = await safeReadManifest(io, p("pyproject.toml"));
      if (py === null) return "pyproject.toml is unreadable or unsafe";
      // Scope to the [project] table (PEP 621) — a dependencies key in
      // [tool.*] tables is metadata, not an install requirement. The key may
      // be bare or quoted. Comment-only array bodies count as empty.
      const project = /(?:^|\n)\[project\]\s*\n([\s\S]*?)(?=\n\[|$)/.exec(py);
      if (project !== null) {
        const deps = /(?:^|\n)\s*(?:"dependencies"|dependencies)\s*=\s*\[([\s\S]*?)\]/.exec(
          project[1] ?? "",
        );
        if (deps !== null && stripHashComments(deps[1] ?? "").trim().length > 0) {
          return "pyproject.toml declares dependencies";
        }
      }
    }
    return null;
  }
  return null;
}

// Shape gate for an OFFLINE clone source (localMirrorDir). The path is TRUSTED
// (the fetch phase writes it; it never carries model-controlled input), but
// validate defensively anyway: an absolute, POSIX, traversal-free path with no
// leading '-' (argv-flag injection defense, same spirit as isSafeRepoUrl).
// Existence + symlink-safety are checked separately against the injected io.
// The repro-exec sandbox runs on Linux only, so a POSIX absolute check suffices.
export function isSafeLocalMirrorDir(dir: string): boolean {
  if (dir.length === 0 || dir.length > 4096) return false;
  if (dir.startsWith("-")) return false; // could be parsed as a git flag
  if (!dir.startsWith("/")) return false; // absolute POSIX path only
  const segments = dir.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === "." || s === "..")) return false;
  return true;
}

type SafeWriteResult =
  | { ok: true; absolutePath: string }
  | { ok: false; kind: "unsafe_repro_write" | "invalid_input"; notes: string };

// Write the generated repro file into the worktree with every write-side
// safety check the spec requires:
//   - re-validate the repo-relative path (isSafeReproPath: no traversal, no
//     leading slash, no backslash / drive),
//   - refuse any path under `.git`,
//   - confine the resolved target strictly inside the worktree
//     (resolve + startsWith, matching the evidence-path guard),
//   - lstat (NO-follow) every parent directory AND the target: refuse if any
//     component is a symlink (a symlinked parent could redirect the write out
//     of the worktree even though the string path looks clean),
//   - no-clobber: refuse to overwrite an existing file,
//   - restrict the file mode.
async function safeWriteReproFile(
  io: ReproVerifierIo,
  worktree: string,
  file: { path: string; contents: string },
): Promise<SafeWriteResult> {
  // Path shape (same gate the generator applied).
  if (!isSafeReproPath(file.path)) {
    return {
      ok: false,
      kind: "unsafe_repro_write",
      notes: `repro file path '${file.path}' failed the safe-path gate; refusing to write`,
    };
  }
  // Re-enforce the content-size cap at the WRITE boundary (defense in depth).
  // Generation already caps at REPRO_FILE_MAX_BYTES, but THIS is the code that
  // puts bytes on disk — an alternate or mutated caller must not be able to
  // plant an arbitrarily large file. Byte length (not char length) is the cap.
  if (Buffer.byteLength(file.contents, "utf8") > REPRO_FILE_MAX_BYTES) {
    return {
      ok: false,
      kind: "unsafe_repro_write",
      notes: `repro file '${file.path}' contents exceed ${REPRO_FILE_MAX_BYTES} bytes; refusing to write`,
    };
  }
  // Never write under .git — a repro that plants a hook / config there could
  // execute on the next git invocation. Reject `.git` as any path segment.
  const segments = file.path.split("/").filter((s) => s.length > 0);
  if (segments.some((seg) => seg === ".git")) {
    return {
      ok: false,
      kind: "unsafe_repro_write",
      notes: `repro file path '${file.path}' is under .git; refusing to write`,
    };
  }

  const { resolve: resolvePath, sep } = await import("node:path");
  const absoluteWorktree = resolvePath(worktree);
  const absoluteTarget = resolvePath(absoluteWorktree, file.path);
  // Confine strictly inside the worktree. The trailing `+ sep` stops a sibling
  // `/tmp/antfleet-pv-xxxxabc` from passing when worktree is
  // `/tmp/antfleet-pv-xxxx`. The path can never equal the worktree itself (a
  // repro must be a file, not the root), so no `=== worktree` allowance.
  if (!absoluteTarget.startsWith(absoluteWorktree + sep)) {
    return {
      ok: false,
      kind: "unsafe_repro_write",
      notes: `repro file path '${file.path}' resolves outside the worktree; refusing to write`,
    };
  }

  // Walk every path COMPONENT from the worktree down to (and including) the
  // target and lstat it WITHOUT following symlinks. isSafeReproPath already
  // proved a POSIX relative path with no `..`, so building the components by
  // joining successive segments is sound. A symlinked component — parent or
  // leaf — is refused: resolvePath does not dereference links, so a tracked
  // `sub -> /etc` would pass the startsWith check yet redirect the write.
  let current = absoluteWorktree;
  for (const seg of segments) {
    current = resolvePath(current, seg);
    // The final component (the target file) must ALSO not already exist as a
    // symlink; lstat catches both a symlinked dir and a symlinked leaf.
    if (await io.lstatIsSymlink(current)) {
      return {
        ok: false,
        kind: "unsafe_repro_write",
        notes: `repro file path component '${seg}' is a symlink; refusing to write`,
      };
    }
  }

  // No-clobber + restricted mode. writeFileNoClobber throws on an existing
  // file (prod uses the `wx` flag) — treat any write failure as a refusal
  // rather than proceeding.
  try {
    await io.writeFileNoClobber(absoluteTarget, file.contents, REPRO_FILE_MODE);
  } catch (err) {
    return {
      ok: false,
      kind: "unsafe_repro_write",
      notes: `could not write repro file '${file.path}' (no-clobber): ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  return { ok: true, absolutePath: absoluteTarget };
}

// Inconclusive-outcome builder for the repro path. Mirrors patch-verifier's
// private `inconclusive` helper but threads the repro proof fields so a
// non-verified outcome can still carry whatever observations were made before
// it bailed (e.g. the pre-patch exit code on a patch_apply_failed).
function reproInconclusive(args: {
  worktreePath: string;
  notes: string;
  ms: number;
  kind: PatchVerifyOutcome["inconclusiveReason"];
  detector?: RunnerKind;
  testCmd?: string | null;
  testExitCode?: number | null;
  testMs?: number | null;
  error?: string | null;
  reproCmd?: string | null;
  reproPreExitCode?: number | null;
  reproPostExitCode?: number | null;
  reproPreMs?: number | null;
  reproPostMs?: number | null;
}): PatchVerifyOutcome {
  return {
    verdict: "inconclusive",
    detector: args.detector ?? "none",
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
    reproCmd: args.reproCmd ?? null,
    reproPreExitCode: args.reproPreExitCode ?? null,
    reproPostExitCode: args.reproPostExitCode ?? null,
    reproPreMs: args.reproPreMs ?? null,
    reproPostMs: args.reproPostMs ?? null,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Real-world IO. Extends realPatchVerifierIo's bindings with the two
// write-side seams the repro verifier adds (symlink-component probe + no-
// clobber restricted-mode writer). Test callers pass their own ReproVerifierIo.
// ────────────────────────────────────────────────────────────────────────

export async function realReproVerifierIo(): Promise<ReproVerifierIo> {
  const { realPatchVerifierIo } = await import("./patch-verifier");
  const { lstat, writeFile } = await import("node:fs/promises");
  return {
    ...realPatchVerifierIo(),
    lstatIsSymlink: async (path) => {
      try {
        return (await lstat(path)).isSymbolicLink();
      } catch (err) {
        // ENOENT is the expected, safe case: the intermediate dir or leaf does
        // not exist yet → it is not a symlink (the no-clobber `wx` write handles
        // the leaf). ANY OTHER error (EACCES, ELOOP, EIO, …) is treated AS a
        // symlink → fail CLOSED and refuse the write rather than silently
        // proceeding. (Audit 2026-07-11: all lstat errors were read as "safe".)
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        return true;
      }
    },
    writeFileNoClobber: async (path, contents, mode) => {
      // `wx` = write, fail if the path already exists (no-clobber). `mode`
      // applies only on creation, which is exactly the create-new case here.
      await writeFile(path, contents, { encoding: "utf8", mode, flag: "wx" });
    },
  };
}
