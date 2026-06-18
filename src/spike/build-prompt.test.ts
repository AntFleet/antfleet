import { describe, it, expect } from "vitest";
import { buildSpikePrompt } from "./build-prompt.js";

const baseArgs = {
  projectName: "demo",
  projectRoot: ".",
  featureId: "feat-1",
  featureTitle: "demo feature",
} as const;

describe("buildSpikePrompt — smart-contract supplement", () => {
  it("omits the supplement when no Solidity files are present", () => {
    const prompt = buildSpikePrompt({
      ...baseArgs,
      files: [
        { path: "src/a.ts", contents: "export const a = 1;" },
        { path: "src/b.js", contents: "module.exports = {};" },
      ],
    });
    expect(prompt).not.toContain("Smart contract supplement");
    expect(prompt).not.toContain("reentrancy");
    expect(prompt).not.toContain("oracle misuse");
  });

  it("appends the supplement when a .sol file is present", () => {
    const prompt = buildSpikePrompt({
      ...baseArgs,
      files: [
        { path: "src/Vault.sol", contents: "// vault" },
        { path: "src/util.ts", contents: "export const x = 1;" },
      ],
    });
    expect(prompt).toContain("Smart contract supplement");
    expect(prompt).toContain("reentrancy and external-call ordering");
    expect(prompt).toContain("oracle misuse");
    expect(prompt).toContain("access control and privilege escalation");
  });

  it("matches uppercase .SOL extension", () => {
    const prompt = buildSpikePrompt({
      ...baseArgs,
      files: [{ path: "contracts/Foo.SOL", contents: "// solidity" }],
    });
    expect(prompt).toContain("Smart contract supplement");
  });

  it("does not match .sol substring inside a non-.sol filename", () => {
    const prompt = buildSpikePrompt({
      ...baseArgs,
      files: [{ path: "src/consolidated.ts", contents: "export {};" }],
    });
    expect(prompt).not.toContain("Smart contract supplement");
  });
});
