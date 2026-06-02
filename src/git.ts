import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { runArgv } from "./exec.js";
import { FleetError } from "./errors.js";

export type GitInfo = {
  root: string | null;
  remoteUrl: string | null;
  defaultBranch: string | null;
  currentBranch: string | null;
  headSha: string | null;
  dirty: boolean;
};

export async function discoverGit(cwd: string): Promise<GitInfo> {
  const root = await gitLine(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === null) {
    return {
      root: null,
      remoteUrl: null,
      defaultBranch: null,
      currentBranch: null,
      headSha: null,
      dirty: false,
    };
  }
  const [remoteUrl, currentBranch, headSha, statusOutput, originHead] = await Promise.all([
    gitLine(root, ["config", "--get", "remote.origin.url"]),
    gitLine(root, ["branch", "--show-current"]),
    gitLine(root, ["rev-parse", "HEAD"]),
    gitText(root, ["status", "--porcelain"]),
    gitLine(root, ["symbolic-ref", "refs/remotes/origin/HEAD"]),
  ]);
  return {
    root,
    remoteUrl,
    defaultBranch: originHead?.replace("refs/remotes/origin/", "") ?? null,
    currentBranch,
    headSha,
    dirty: statusOutput.trim().length > 0,
  };
}

export async function findProjectRoot(cwd: string, explicitRoot?: string): Promise<string> {
  if (explicitRoot !== undefined) {
    const info = await stat(explicitRoot).catch(() => null);
    if (info === null || !info.isDirectory()) {
      throw new FleetError(`root not found: ${explicitRoot}`, 2, "invalid-root");
    }
    return explicitRoot;
  }
  const git = await discoverGit(cwd);
  return git.root ?? cwd;
}

export function projectNameFromRoot(root: string, remoteUrl: string | null): string {
  if (remoteUrl !== null) {
    const withoutGit = remoteUrl.replace(/\.git$/u, "");
    const last = withoutGit.split(/[/:]/u).at(-1);
    if (last !== undefined && last.length > 0) {
      return last;
    }
  }
  return basename(root);
}

async function gitLine(cwd: string, args: string[]): Promise<string | null> {
  const result = await runArgv("git", args, cwd);
  if (result.exitCode !== 0) {
    return null;
  }
  const line = result.stdout.trim();
  return line.length > 0 ? line : null;
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  const result = await runArgv("git", args, cwd);
  return result.exitCode === 0 ? result.stdout : "";
}
