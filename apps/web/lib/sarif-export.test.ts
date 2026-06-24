import { describe, expect, it } from "vitest";
import { findingsToSarif, validateSarifForGithub, type ExportableFinding } from "./sarif-export";

describe("findingsToSarif", () => {
  it("serializes AntFleet findings as GitHub-compatible SARIF", () => {
    const sarif = findingsToSarif({
      owner: "AntFleet",
      repo: "bench",
      findings: [finding("af-1", "high")],
    });
    expect(validateSarifForGithub(sarif)).toEqual([]);
    expect(sarif.version).toBe("2.1.0");
    const run = sarif.runs[0] as { tool: { driver: { name: string } }; results: unknown[] };
    expect(run.tool.driver.name).toBe("AntFleet");
    expect(run.results).toHaveLength(1);
  });

  it("omits embargoed findings when caller applies visibility before serialization", () => {
    const visible = [finding("public-1", "medium")];
    const embargoed = finding("embargoed-1", "critical");
    const sarif = findingsToSarif({ owner: "AntFleet", repo: "bench", findings: visible });
    const json = JSON.stringify(sarif);
    expect(json).toContain("public-1");
    expect(json).not.toContain(embargoed.findingId);
  });
});

function finding(findingId: string, severity: string): ExportableFinding {
  return {
    findingId,
    title: "reachable unsafe call",
    severity,
    category: "security",
    status: "closed",
    closureSha: "abc",
    patchAcceptedSha: "def",
    reviewId: "review-1",
    owner: "AntFleet",
    repo: "bench",
    prNumber: 1,
    commitSha: "111",
    evidenceBundle: {
      affectedSha: "111",
      bundleStatus: "complete",
      pocSnippet: { value: { path: "src/app.ts", line: 12 } },
      reproductionCommand: { value: "pnpm test" },
      callPathTrace: { value: { path: "src/app.ts", line: 12, callPath: ["handler", "sink"] } },
    },
  };
}
