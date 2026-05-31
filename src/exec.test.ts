import { describe, expect, it } from "vitest";
import { runCommand } from "./exec.js";

const node = JSON.stringify(process.execPath);

describe("runCommand", () => {
  it("returns null exitCode when the timeout kills a command", async () => {
    const result = await runCommand(
      `${node} -e "setTimeout(() => {}, 1000)"`,
      process.cwd(),
      undefined,
      { timeoutMs: 25 },
    );

    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("command timed out");
  });

  it("bounds captured stdout while retaining head and tail", async () => {
    const result = await runCommand(
      `${node} -e "process.stdout.write('a'.repeat(10000) + 'TAIL')"`,
      process.cwd(),
      undefined,
      { timeoutMs: 5_000 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("...[trimmed ");
    expect(result.stdout.endsWith("TAIL")).toBe(true);
    expect(result.stdout.length).toBeLessThan(8_200);
  });
});
