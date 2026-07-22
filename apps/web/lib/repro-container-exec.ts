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
    "--network",
    "none",
    "--name",
    containerName,
    // Clear all inherited env; only the explicit -e below enter the container.
    "--env-file",
    "/dev/null",
  ];
  if (opts.user !== undefined && opts.user.length > 0) {
    args.push("--user", opts.user);
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

// Spawn `docker run …`. On timeout, `docker kill <name>` tears the container
// (and every process in it) down, then the CLI is SIGKILLed. Never rejects —
// an infra/spawn failure resolves to exitCode:null (the verifier treats a null
// exit as inconclusive, never `verified`).
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
        // Kill the container itself, not just the CLI — a detached `docker run`
        // child would otherwise leave the container (and its grandchildren)
        // alive past the CLI's death.
        spawn(dockerPath, ["kill", containerName], { stdio: "ignore" }).on("error", () => {});
        child.kill("SIGKILL");
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
