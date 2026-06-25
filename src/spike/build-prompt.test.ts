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

describe("buildSpikePrompt — cyber-tier preamble", () => {
  it("omits the cyber preamble when tier is unset (default-tier behavior unchanged)", () => {
    const prompt = buildSpikePrompt({
      ...baseArgs,
      files: [{ path: "src/a.ts", contents: "export const a = 1;" }],
    });
    expect(prompt).not.toContain("AntFleet Cyber tier");
    expect(prompt).not.toContain("proof-of-concept");
    expect(prompt.startsWith("You are reviewing one semantic feature for fleet.")).toBe(true);
  });

  it("omits the cyber preamble when tier is explicitly 'default'", () => {
    const prompt = buildSpikePrompt({
      ...baseArgs,
      files: [{ path: "src/a.ts", contents: "export const a = 1;" }],
      tier: "default",
    });
    expect(prompt).not.toContain("AntFleet Cyber tier");
    expect(prompt.startsWith("You are reviewing one semantic feature for fleet.")).toBe(true);
  });

  it("prepends the cyber preamble when tier is 'cyber'", () => {
    const prompt = buildSpikePrompt({
      ...baseArgs,
      files: [{ path: "src/a.ts", contents: "export const a = 1;" }],
      tier: "cyber",
    });
    expect(prompt).toContain("AntFleet Cyber tier");
    expect(prompt).toContain("proof-of-concept");
    expect(prompt).toContain("coordinated-disclosure private channels");
    expect(prompt).toContain("findings must be evidence-driven");
    // The base review prompt still follows the preamble.
    expect(prompt).toContain("You are reviewing one semantic feature for fleet.");
  });

  it("default-tier prompt is byte-identical with and without explicit tier", () => {
    const withoutTier = buildSpikePrompt({
      ...baseArgs,
      files: [{ path: "src/a.ts", contents: "export const a = 1;" }],
    });
    const withDefault = buildSpikePrompt({
      ...baseArgs,
      files: [{ path: "src/a.ts", contents: "export const a = 1;" }],
      tier: "default",
    });
    expect(withoutTier).toBe(withDefault);
  });
});
