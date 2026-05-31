import { spawn } from "node:child_process";
import { CommandResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const OUTPUT_HEAD_CHARS = 4_000;
const OUTPUT_TAIL_CHARS = 4_000;
const TERMINATION_GRACE_MS = 2_000;

export type RunCommandOptions = {
  timeoutMs?: number;
};

export async function runCommand(
  command: string,
  cwd: string,
  input?: string,
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const started = Date.now();
  const child = spawn(command, {
    cwd,
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const stdout = new OutputBuffer();
  const stderr = new OutputBuffer();
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = readTimeoutMs(options.timeoutMs);
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    stderr.append(`\n[command timed out after ${timeoutMs}ms]\n`);
    terminateChild(child.pid, "SIGTERM");
    killTimer = setTimeout(() => terminateChild(child.pid, "SIGKILL"), TERMINATION_GRACE_MS);
  }, timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout.append(chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr.append(chunk);
  });
  if (input !== undefined) {
    child.stdin.end(input);
  } else {
    child.stdin.end();
  }
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("close", resolve);
    child.on("error", reject);
  });
  clearTimeout(timeoutTimer);
  if (killTimer !== undefined) clearTimeout(killTimer);
  return {
    command,
    cwd,
    exitCode: timedOut ? null : exitCode,
    durationMs: Date.now() - started,
    stdout: stdout.toString(),
    stderr: stderr.toString(),
  };
}

function readTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
}

function terminateChild(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

class OutputBuffer {
  private head = "";
  private tail = "";
  private omitted = 0;

  append(chunk: string): void {
    let rest = chunk;
    if (this.head.length < OUTPUT_HEAD_CHARS) {
      const take = Math.min(OUTPUT_HEAD_CHARS - this.head.length, rest.length);
      this.head += rest.slice(0, take);
      rest = rest.slice(take);
    }
    if (rest.length === 0) return;
    this.tail += rest;
    if (this.tail.length > OUTPUT_TAIL_CHARS) {
      const overflow = this.tail.length - OUTPUT_TAIL_CHARS;
      this.omitted += overflow;
      this.tail = this.tail.slice(overflow);
    }
  }

  toString(): string {
    if (this.omitted === 0) {
      return this.head + this.tail;
    }
    return `${this.head}\n...[trimmed ${this.omitted} chars]...\n${this.tail}`;
  }
}
