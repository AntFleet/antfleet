// Per-command container isolation for the repro-exec runner (Build 2b-2).
//
// The verdict-forge review (#159) showed why running the whole exec phase in
// ONE container with a shared verdict file is wrong: hostile repo code, running
// in the same container, can overwrite the verdict after the trusted writer
// closes it (repro-verifier.ts admits "a daemonized grandchild survives" the
// timeout). The fix is structural, per the architect lane:
//
//   The orchestrator (runReproVerifier) runs on the trusted runner, OUTSIDE any
//   container. Each UNTRUSTED command it issues — git clone from the mirror, the
//   model's repro cmd, the repo's test suite — runs in its OWN
//   `docker run --network none` container. The verdict is the orchestrator's
//   return value, computed from the exit codes docker reports, written to a file
//   on the runner that no hostile container is ever mounted into.
//
// Why this is forge-resistant:
//   - hostile code cannot reach the verdict (it is decided + written outside any
//     container it runs in),
//   - it cannot affect another spec (separate container per command per spec),
//   - it cannot outlive its command: `--rm` + the container PID namespace means
//     every process it spawned — daemonized grandchildren included — is killed
//     when that one `docker run` exits,
//   - `--network none` denies egress at the kernel layer (loopback only),
//   - `--env-file /dev/null` + explicit `-e` pass ONLY the verifier's minimal
//     env; no runner secret is inherited.
// It does NOT remove the inherent "untrusted differential": the repro drives the
// repo's own (attacker-controlled) tooling, so a `verified` still means "exit 0
// pre → non-zero post", not a cryptographic proof. That limitation is unchanged
// and documented in repro-verifier.ts.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ExecArgs, ExecResult } from "./patch-verifier";

export type ContainerMount = {
  host: string;
  container: string;
  readOnly?: boolean;
};

export type SpawnDockerResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type ContainerExecOptions = {
  // Digest-pinned image (e.g. node:26-bookworm@sha256:...). MUST carry git +
  // the repro toolchain; --network none means the repro cannot install deps.
  image: string;
  // Per-spec read-only mounts (the bare mirror). The command's cwd (the
  // worktree) is always mounted rw and never needs to be listed here.
  extraMounts?: ContainerMount[];
  dockerPath?: string;
  // "uid:gid" — run the container as the runner user so files written into the
  // mounted worktree are not left root-owned (breaks runner-side cleanup).
  user?: string;
  // Give the container the default bridge network instead of `--network none`.
  // Set ONLY for the dep-prefetch step (npm/pnpm install), which must reach the
  // registry. It is a HARD RULE that this is NEVER true for a verdict-affecting
  // command (repro pre/post, test suite): those stay offline so their result
  // cannot be steered over the network. Safe for install because the exec job
  // carries no secrets (nothing to exfiltrate), the install runs with
  // --ignore-scripts (no attacker code executes on the network), and the
  // container is torn down (`--rm`, own net/PID namespace) before the offline
  // suite container starts, so no daemon it spawns can survive to serve the suite.
  allowNetwork?: boolean;
  // Resource caps (codex audit #164). Set on the networked install container to
  // bound the egress-window abuse surface (mining / fork-bomb / disk). Passed
  // verbatim to `--memory` / `--cpus` / `--pids-limit`. Omitted → docker default
  // (unbounded); the offline verdict-affecting containers leave these unset so a
  // legitimately heavy suite is not OOM/PID-killed into a false `regressed`.
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  // Test seam. Production omits it and the module spawns the real docker CLI.
  spawnDocker?: (dockerArgs: string[], timeoutMs: number) => Promise<SpawnDockerResult>;
};

// Defense in depth: the env reaching a hostile container must carry no
// secret-shaped value. The env is built by the verifier (minimalEnv — PATH,
// HOME, …) so this should never fire; it fails closed if minimalEnv ever
// regresses and a credential leaks into the untrusted command.
const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_URL|DSN|COOKIE)/i;

export function assertContainerEnvClean(env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v.length > 0 && SECRET_KEY_RE.test(k)) {
      throw new Error(
        `[repro-container-exec] refusing to pass a secret-shaped env var into the ` +
          `untrusted container: ${k}`,
      );
    }
  }
}

export function buildDockerArgs(
  a: ExecArgs,
  opts: ContainerExecOptions,
  containerName: string,
): string[] {
  const args = [
    "run",
    "--rm",
    // `none` for every verdict-affecting command; `bridge` ONLY for the
    // dep-prefetch install (opts.allowNetwork). assertContainerEnvClean below
    // still runs, so even the networked install container carries no secret.
    "--network",
    opts.allowNetwork === true ? "bridge" : "none",
    "--name",
    containerName,
    // Clear all inherited env; only the explicit -e below enter the container.
    "--env-file",
    "/dev/null",
  ];
  if (opts.user !== undefined && opts.user.length > 0) {
    args.push("--user", opts.user);
  }
  if (opts.memory !== undefined && opts.memory.length > 0) {
    args.push("--memory", opts.memory);
  }
  if (opts.cpus !== undefined && opts.cpus.length > 0) {
    args.push("--cpus", opts.cpus);
  }
  if (opts.pidsLimit !== undefined) {
    args.push("--pids-limit", String(opts.pidsLimit));
  }
  for (const [k, v] of Object.entries(a.env)) {
    args.push("-e", `${k}=${v}`);
  }
  // The worktree (cwd) is the one rw mount; extra mounts (the mirror) are ro.
  args.push("-v", `${a.cwd}:${a.cwd}`);
  for (const m of opts.extraMounts ?? []) {
    args.push("-v", `${m.host}:${m.container}${m.readOnly === true ? ":ro" : ""}`);
  }
  args.push("-w", a.cwd, opts.image, a.command, ...a.args);
  return args;
}

// Spawn `docker run …`. On timeout, `docker rm -f <name>` force-stops AND
// removes the container (and every process in it), then the CLI is SIGKILLed.
// Never rejects — an infra/spawn failure resolves to exitCode:null (the verifier
// treats a null exit as inconclusive, never `verified`).
function defaultSpawnDocker(
  dockerPath: string,
  containerName: string,
): (dockerArgs: string[], timeoutMs: number) => Promise<SpawnDockerResult> {
  return (dockerArgs, timeoutMs) =>
    new Promise<SpawnDockerResult>((resolve) => {
      const child = spawn(dockerPath, dockerArgs, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // Force-REMOVE the container (stops + deletes it, destroying its PID
        // namespace → every process, daemonized grandchildren included), THEN
        // SIGKILL the CLI. `docker rm -f` is stronger than `docker kill`: it does
        // not rely on `--rm` running on the client, so even if the CLI raced or
        // `kill` would have failed, a detached/networked container cannot keep
        // running with its rw worktree mount (codex audit #164). Sequencing the
        // CLI kill after `rm -f` closes avoids that race; on error we still
        // SIGKILL the CLI so we never hang.
        let clientKilled = false;
        const killClient = () => {
          if (clientKilled) return; // never SIGKILL twice
          clientKilled = true;
          child.kill("SIGKILL");
        };
        // Force-remove the container; if it fails (nonzero close or spawn error),
        // retry ONCE — a single failed `rm -f` must not silently leave a
        // networked container alive for later specs (codex re-audit #164). A
        // spawn error emits BOTH 'error' and 'close', so a per-attempt
        // once-settler prevents a double retry. A hard 5s cap per attempt means a
        // hung `docker rm -f` cannot hang the promise — we SIGKILL the client and
        // let the daemon finish the removal.
        const removeOnce = (attempt: number): void => {
          const remover = spawn(dockerPath, ["rm", "-f", containerName], { stdio: "ignore" });
          // Detach: a slow/hung removal must never pin the Node process (it
          // proceeds daemon-side regardless of whether we keep waiting).
          remover.unref();
          let settled = false;
          const settle = (ok: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(cap);
            if (!ok && attempt === 0) {
              removeOnce(1);
              return;
            }
            killClient();
          };
          // Hard cap per attempt: a hung `docker rm -f` cannot hang the promise.
          // Kill the (detached) remover before settling so it can't linger.
          const cap = setTimeout(() => {
            remover.kill("SIGKILL");
            settle(false);
          }, 5_000);
          cap.unref();
          remover.on("close", (code) => settle(code === 0));
          remover.on("error", () => settle(false));
        };
        removeOnce(0);
      }, timeoutMs);
      child.stdout?.on("data", (c: Buffer) => {
        stdout += c.toString("utf8");
        if (stdout.length > 64_000) stdout = stdout.slice(-32_000);
      });
      child.stderr?.on("data", (c: Buffer) => {
        stderr += c.toString("utf8");
        if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ exitCode: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, stdout, stderr, timedOut });
      });
    });
}

export function makeContainerExec(
  opts: ContainerExecOptions,
): (args: ExecArgs) => Promise<ExecResult> {
  return async (a: ExecArgs): Promise<ExecResult> => {
    assertContainerEnvClean(a.env);
    const containerName = `antfleet-repro-${randomUUID()}`;
    const dockerArgs = buildDockerArgs(a, opts, containerName);
    const spawnDocker =
      opts.spawnDocker ?? defaultSpawnDocker(opts.dockerPath ?? "docker", containerName);
    const start = Date.now();
    const r = await spawnDocker(dockerArgs, a.timeoutMs);
    return {
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      ms: Date.now() - start,
      timedOut: r.timedOut,
    };
  };
}
