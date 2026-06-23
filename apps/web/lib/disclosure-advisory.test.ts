import { describe, expect, it } from "vitest";
import { generateGhsaMarkdown, ghsaInputFromAdvisory } from "./disclosure-advisory";

const baseContext = {
  findingId: "finding-1",
  title: "Unchecked withdrawal authorization",
  severity: "HIGH",
  category: "access-control",
  reviewId: "review-1",
  findingIndex: 0,
  owner: "bench",
  repo: "live-protocol",
  commitSha: "abcdef1234567890",
  prNumber: 42,
  disclosureState: "embargoed" as const,
  agreementDecision: {
    agreed: [
      {
        evidence: [{ path: "contracts/Vault.sol", startLine: 12, endLine: 16 }],
        reasoning: "Missing caller authorization allows unintended withdrawals.",
        recommendation: "Require the caller to own the position before withdrawal.",
      },
    ],
  },
  providerResponses: {},
  evidenceBundle: {
    affectedSha: "abcdef1234567890",
    pocSnippet: { command: "forge test" },
    reproductionCommand: "forge test --match-test testWithdraw",
    callPathTrace: ["withdraw", "_transfer"],
    bundleStatus: "ready",
  },
  threatModel: { publicAccess: "public", trustBoundaries: ["external callers"] },
};

describe("disclosure-advisory", () => {
  it("generates GHSA markdown from finding, evidence bundle, and threat model", () => {
    const markdown = generateGhsaMarkdown(baseContext);

    expect(markdown).toContain("# Unchecked withdrawal authorization");
    expect(markdown).toContain("contracts/Vault.sol:12-16");
    expect(markdown).toContain("Bundle status: `ready`");
    expect(markdown).toContain("external callers");
  });

  it("gracefully omits optional bundle and threat model details", () => {
    const markdown = generateGhsaMarkdown({
      ...baseContext,
      evidenceBundle: null,
      threatModel: null,
    });

    expect(markdown).toContain("No evidence bundle row was available.");
    expect(markdown).toContain("No threat model row was available.");
  });

  it("normalizes GHSA severity and package input", () => {
    expect(ghsaInputFromAdvisory(baseContext)).toMatchObject({
      owner: "bench",
      repo: "live-protocol",
      severity: "high",
      affectedPackageName: "bench/live-protocol",
      vulnerableVersionRange: "<= abcdef123456",
    });
  });
});
