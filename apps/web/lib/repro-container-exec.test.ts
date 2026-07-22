import { describe, expect, it, vi } from "vitest";
import type { ExecArgs } from "./patch-verifier";
import {
  assertContainerEnvClean,
  buildDockerArgs,
  makeContainerExec,
  type ContainerExecOptions,
} from "./repro-container-exec";

const IMAGE = "node:26-bookworm@sha256:" + "a".repeat(64);

function execArgs(over: Partial<ExecArgs> = {}): ExecArgs {
  return {
    command: "git",
    args: ["clone", "/tmp/antfleet-mirror-x", "."],
    cwd: "/tmp/antfleet-pv-1",
    timeoutMs: 1000,
    env: { PATH: "/usr/bin", HOME: "/tmp" },
    ...over,
  };
}

describe("assertContainerEnvClean", () => {
  it("passes for the verifier's minimal env", () => {
    expect(() => assertContainerEnvClean({ PATH: "/usr/bin", HOME: "/tmp" })).not.toThrow();
  });

  it("fails closed on any secret-shaped var reaching the untrusted container", () => {
    expect(() => assertContainerEnvClean({ PATH: "/x", DATABASE_URL: "postgres://" })).toThrow(
      /DATABASE_URL/,
    );
    expect(() => assertContainerEnvClean({ GITHUB_TOKEN: "ghp_x" })).toThrow(/GITHUB_TOKEN/);
    expect(() => assertContainerEnvClean({ ANTHROPIC_API_KEY: "sk-x" })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it("ignores an empty secret-shaped var (no value to leak)", () => {
    expect(() => assertContainerEnvClean({ PATH: "/x", SOME_TOKEN: "" })).not.toThrow();
  });
});

describe("buildDockerArgs", () => {
  const opts: ContainerExecOptions = {
    image: IMAGE,
    extraMounts: [
      { host: "/tmp/antfleet-mirror-x", container: "/tmp/antfleet-mirror-x", readOnly: true },
    ],
    user: "1001:1002",
  };

  it("isolates: --network none, --rm, cleared env, named container", () => {
    const a = buildDockerArgs(execArgs(), opts, "antfleet-repro-test");
    expect(a).toContain("--network");
    expect(a[a.indexOf("--network") + 1]).toBe("none");
    expect(a).toContain("--rm");
    expect(a).toContain("--env-file");
    expect(a[a.indexOf("--env-file") + 1]).toBe("/dev/null");
    expect(a).toContain("--name");
    expect(a[a.indexOf("--name") + 1]).toBe("antfleet-repro-test");
  });

  it("allowNetwork:true selects the bridge network ONLY for the install step", () => {
    const online = buildDockerArgs(execArgs(), { ...opts, allowNetwork: true }, "n");
    expect(online[online.indexOf("--network") + 1]).toBe("bridge");
    // Still --rm, still cleared env: a networked install container is not a
    // secret-carrying one.
    expect(online).toContain("--rm");
    expect(online[online.indexOf("--env-file") + 1]).toBe("/dev/null");
    // Default and explicit-false both stay offline.
    const off = buildDockerArgs(execArgs(), { ...opts, allowNetwork: false }, "n");
    expect(off[off.indexOf("--network") + 1]).toBe("none");
  });

  it("runs as the runner user and mounts the worktree rw + mirror ro", () => {
    const a = buildDockerArgs(execArgs(), opts, "n").join(" ");
    expect(a).toContain("--user 1001:1002");
    expect(a).toContain("-v /tmp/antfleet-pv-1:/tmp/antfleet-pv-1 ");
    expect(a).toContain("-v /tmp/antfleet-mirror-x:/tmp/antfleet-mirror-x:ro");
    expect(a).toContain("-w /tmp/antfleet-pv-1");
  });

  it("passes only the given env, then the image, then the command argv-direct", () => {
    const a = buildDockerArgs(execArgs(), opts, "n");
    expect(a).toContain("-e");
    expect(a).toContain("PATH=/usr/bin");
    expect(a).toContain("HOME=/tmp");
    // Image precedes the command; command + its args are argv-direct (no shell).
    const imgIdx = a.indexOf(IMAGE);
    expect(imgIdx).toBeGreaterThan(0);
    expect(a.slice(imgIdx + 1)).toEqual(["git", "clone", "/tmp/antfleet-mirror-x", "."]);
  });
});

describe("makeContainerExec", () => {
  it("routes the command through docker and returns the container exit code", async () => {
    const spawnDocker = vi.fn(async (dockerArgs: string[]) => {
      expect(dockerArgs[0]).toBe("run");
      expect(dockerArgs).toContain("none");
      return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false };
    });
    const exec = makeContainerExec({ image: IMAGE, spawnDocker });
    const r = await exec(execArgs());
    expect(spawnDocker).toHaveBeenCalledOnce();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("ok");
    expect(r.timedOut).toBe(false);
  });

  it("refuses (throws) before spawning docker if a secret-shaped var is present", async () => {
    const spawnDocker = vi.fn();
    const exec = makeContainerExec({ image: IMAGE, spawnDocker });
    await expect(exec(execArgs({ env: { PATH: "/x", API_KEY: "leak" } }))).rejects.toThrow(
      /API_KEY/,
    );
    expect(spawnDocker).not.toHaveBeenCalled();
  });

  it("surfaces a timed-out container as timedOut with a null-safe exit code", async () => {
    const spawnDocker = vi.fn(async () => ({
      exitCode: 137,
      stdout: "",
      stderr: "killed",
      timedOut: true,
    }));
    const exec = makeContainerExec({ image: IMAGE, spawnDocker });
    const r = await exec(execArgs());
    expect(r.timedOut).toBe(true);
  });
});
