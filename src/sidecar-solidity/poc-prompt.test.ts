import { describe, it, expect } from "vitest";
import { buildPocGenerationPrompt, parsePocGenerationOutput } from "./poc-prompt.js";
import type { PocTarget } from "./poc.js";

const TARGET: PocTarget = {
  path: "src/Vault.sol",
  symbol: "Vault",
  kind: "contract",
  derivation: "enclosing concrete contract at primary cited line",
};

const FINDING = {
  title: "epoch outflow cap tracks inflow",
  severity: "high" as const,
  confidence: "medium" as const,
  reasoning: "the sign is inverted",
  evidence: [{ path: "src/Vault.sol", startLine: 12, endLine: 14, symbol: "Vault", quote: null }],
  triggerRole: "any unprivileged actor",
  preconditions: "pool has liquidity",
};

describe("buildPocGenerationPrompt", () => {
  const prompt = buildPocGenerationPrompt({
    finding: FINDING,
    pocTarget: TARGET,
    files: [{ path: "src/Vault.sol", contents: "contract Vault {}" }],
    programRules: "in scope: fund extraction",
    nonce: "NONCE1",
  });

  it("names the resolved target symbol and path", () => {
    expect(prompt).toContain("Vault");
    expect(prompt).toContain("src/Vault.sol");
  });

  it("cites the finding evidence", () => {
    expect(prompt).toContain("src/Vault.sol:12-14");
  });

  it("forbids fabrication + scope escape hatches and forge flags", () => {
    expect(prompt).toContain("testAuditPoc");
    expect(prompt.toLowerCase()).toContain("straight-line");
    expect(prompt).toContain("vm.deal");
    expect(prompt).toContain("NEVER to the");
    expect(prompt).toContain("assertTrue(true)");
  });

  it("defines the decline / output JSON shape", () => {
    expect(prompt).toContain('"testContents"');
    expect(prompt).toContain("DECLINE");
  });

  it("fences untrusted files with the nonce", () => {
    expect(prompt).toContain("NONCE1");
  });
});

describe("parsePocGenerationOutput", () => {
  it("accepts a full test file", () => {
    const r = parsePocGenerationOutput({ testContents: "// SPDX\ncontract A {}", rationale: null });
    expect(r.testContents).not.toBeNull();
  });

  it("treats a null / empty testContents as a decline", () => {
    expect(
      parsePocGenerationOutput({ testContents: null, rationale: "needs fork" }).testContents,
    ).toBeNull();
    expect(
      parsePocGenerationOutput({ testContents: "   ", rationale: null }).testContents,
    ).toBeNull();
  });

  it("never throws on a malformed payload", () => {
    expect(parsePocGenerationOutput(42).testContents).toBeNull();
    expect(parsePocGenerationOutput(null).testContents).toBeNull();
  });
});
