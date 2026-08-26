import { describe, it, expect } from "vitest";
import { AUDIT_JSON_SHAPE, buildFullContractAuditPrompt } from "./prompt.js";

const files = [
  { path: "contracts/Vault.sol", contents: "contract Vault {}" },
  { path: "lib/WadRay.sol", contents: "library WadRay {}" },
];

describe("buildFullContractAuditPrompt — hand-prototype Mode-B objective", () => {
  const prompt = buildFullContractAuditPrompt({
    projectName: "target-x",
    entryContracts: ["contracts/Vault.sol"],
    files,
    programRules: "High: unprivileged fund extraction. Out of scope: UI, config.",
  });

  it("frames the task as a whole-codebase audit, not a diff review", () => {
    expect(prompt).toContain("full-codebase smart-contract audit");
    expect(prompt).toContain("There is no diff");
  });

  it("carries the fund-extraction objective verbatim themes", () => {
    expect(prompt).toContain("OUT of the protocol or PERMANENTLY freezes");
    expect(prompt).toContain("PERMANENTLY freezes");
    expect(prompt).toContain("WITHOUT a privileged role");
  });

  it("suppresses local-anomaly noise unless mapped to fund loss/freeze", () => {
    expect(prompt).toContain("only reportable if they map to a concrete fund-loss/freeze path");
  });

  it("embeds the program rules and lists entry contracts", () => {
    expect(prompt).toContain("unprivileged fund extraction. Out of scope");
    expect(JSON.stringify(["contracts/Vault.sol"])).toContain("contracts/Vault.sol");
  });

  it("warns the model that factor failures DROP candidates at scoring time", () => {
    expect(prompt).toContain("will DROP the candidate at scoring time");
  });

  it("requires the §C factor fields in the JSON shape", () => {
    for (const field of [
      "triggerRole",
      "preconditions",
      "unprivilegedReachable",
      "recoverableUnder1hr",
      "inScope",
      "duplicateOf",
    ]) {
      expect(AUDIT_JSON_SHAPE).toContain(field);
      expect(prompt).toContain(field);
    }
  });

  it("includes all closure file blocks with paths as evidence anchors", () => {
    expect(prompt).toContain("--- contracts/Vault.sol");
    expect(prompt).toContain("--- lib/WadRay.sol");
  });
});
