import { describe, it, expect } from "vitest";
import { advisorySummary, groundFinding, promote, type GroundedFile } from "./scoring.js";
import type { AuditFinding } from "./finding-schema.js";
import { auditFindingSchema } from "./finding-schema.js";

const closure: GroundedFile[] = [
  {
    path: "contracts/Vault.sol",
    contents:
      '// SPDX\npragma solidity ^0.8.0;\ncontract Vault {\n    function withdraw() external {\n        msg.sender.call{value: address(this).balance}("");\n    }\n}\n',
  },
];

function findingWith(evidence: AuditFinding["evidence"]): AuditFinding {
  return auditFindingSchema.parse({
    title: "drain via withdraw",
    severity: "critical",
    confidence: "high",
    evidence,
    reasoning: "unprivileged call drains balance",
  });
}

describe("groundFinding — mechanical citation check (no model)", () => {
  it("PASSes an evidence entry that resolves to real lines", () => {
    const finding = findingWith([
      { path: "contracts/Vault.sol", startLine: 4, endLine: 5, symbol: null, quote: null },
    ]);
    expect(groundFinding(finding, closure)).toEqual({ ok: true });
  });

  it("DROPs a no-evidence finding (empty evidence array)", () => {
    const finding = findingWith([]);
    const result = groundFinding(finding, closure);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no evidence entries");
  });

  it("DROPs a fabricated path not in the closure", () => {
    const finding = findingWith([
      { path: "contracts/NotThere.sol", startLine: 1, endLine: 2, symbol: null, quote: null },
    ]);
    const result = groundFinding(finding, closure);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not in the assembled closure");
  });

  it("DROPs fabricated line numbers beyond the file's real bounds", () => {
    const finding = findingWith([
      { path: "contracts/Vault.sol", startLine: 400, endLine: 420, symbol: null, quote: null },
    ]);
    const result = groundFinding(finding, closure);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("outside real bounds");
  });

  it("DROPs a zero/negative line range", () => {
    const finding = findingWith([
      { path: "contracts/Vault.sol", startLine: 0, endLine: 1, symbol: null, quote: null },
    ]);
    expect(groundFinding(finding, closure).ok).toBe(false);
  });

  it("DROPs when a present quote does not match the cited span", () => {
    const finding = findingWith([
      {
        path: "contracts/Vault.sol",
        startLine: 4,
        endLine: 5,
        symbol: null,
        quote: "selfdestruct(block.coinbase)",
      },
    ]);
    const result = groundFinding(finding, closure);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("quote does not match");
  });

  it("accepts a whitespace-normalized matching quote", () => {
    const finding = findingWith([
      {
        path: "Vault.sol", // suffix-resolved citation
        startLine: 4,
        endLine: 5,
        symbol: null,
        quote: 'msg.sender.call{value:    address(this).balance}("");',
      },
    ]);
    expect(groundFinding(finding, closure)).toEqual({ ok: true });
  });

  it("grounds a correct quote cited at WRONG line numbers and re-anchors it (e2e regression)", () => {
    // The blocker the live e2e exposed: LLMs quote real code but miscount lines,
    // so a span-exact check false-DROPped 100% of real findings.
    const finding = findingWith([
      {
        path: "contracts/Vault.sol",
        startLine: 99, // wrong (and out of bounds) — the quote is authoritative
        endLine: 99,
        symbol: null,
        quote: 'msg.sender.call{value: address(this).balance}("");',
      },
    ]);
    expect(groundFinding(finding, closure)).toEqual({ ok: true });
    // Re-anchored to the quote's true location (line 5 in the fixture).
    expect(finding.evidence[0]?.startLine).toBe(5);
  });

  it("grounds a multi-line quote when the model altered ONE line (anchor on a real distinctive line)", () => {
    // Full-tree e2e regression: opus quoted a real multi-line function but with a
    // reflowed/added line, breaking whole-block match though the citation is real.
    const finding = findingWith([
      {
        path: "contracts/Vault.sol",
        startLine: 40,
        endLine: 44,
        symbol: null,
        quote:
          'function withdraw() external {\n    msg.sender.call{value: address(this).balance}("");\n    // NOTE: model-added line not in the source\n}',
      },
    ]);
    expect(groundFinding(finding, closure)).toEqual({ ok: true });
  });

  it("grounds an ELIDED quote (`frag ... frag`) whose fragments are all verbatim-present (Puffer VaultV5 regression)", () => {
    // Live on Puffer VaultV5: the finder renders evidence as
    // `function sig { body ... }` in ONE quote string with literal `...` for
    // omitted code, which false-DROPped 3/3 findings whose fragments were real.
    const elidedClosure: GroundedFile[] = [
      {
        path: "src/PufferVaultV5.sol",
        contents:
          "// SPDX\n" +
          "contract PufferVaultV5 {\n" +
          "    function initialize(address accessManager) public initializer {\n" +
          "        __AccessManaged_init(accessManager);\n" +
          "        __ERC4626_init(IERC20(address(0)));\n" +
          "    }\n" +
          "    function transferETH(address to, uint256 ethAmount) external restricted {\n" +
          '        (bool success,) = to.call{ value: ethAmount }("");\n' +
          "        require(success);\n" +
          "    }\n" +
          "}\n",
      },
    ];
    const finding = auditFindingSchema.parse({
      title: "uninitialized proxy takeover",
      severity: "high",
      evidence: [
        {
          path: "src/PufferVaultV5.sol",
          startLine: 76,
          endLine: 82,
          symbol: null,
          quote:
            "function initialize(address accessManager) public initializer { __AccessManaged_init(accessManager); ... }",
        },
        {
          path: "src/PufferVaultV5.sol",
          startLine: 437,
          endLine: 448,
          symbol: null,
          quote:
            'function transferETH(address to, uint256 ethAmount) external restricted { ... (bool success,) = to.call{ value: ethAmount }("");',
        },
      ],
      reasoning: "unprivileged init + transferETH drain",
    });
    expect(groundFinding(finding, elidedClosure)).toEqual({ ok: true });
    // Re-anchored to the first fragment's true line (initialize is at line 3).
    expect(finding.evidence[0]?.startLine).toBe(3);
  });

  it("still DROPs an elided quote when a substantial fragment is fabricated", () => {
    const finding = findingWith([
      {
        path: "contracts/Vault.sol",
        startLine: 4,
        endLine: 5,
        symbol: null,
        quote: "function withdraw() external { ... selfdestruct(payable(attacker)); }",
      },
    ]);
    const result = groundFinding(finding, closure);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("quote does not match");
  });

  it("still DROPs a quote that appears nowhere in the file (fabrication defense)", () => {
    const finding = findingWith([
      {
        path: "contracts/Vault.sol",
        startLine: 5,
        endLine: 5,
        symbol: null,
        quote: "selfdestruct(payable(attacker));",
      },
    ]);
    const result = groundFinding(finding, closure);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("quote does not match");
  });
});

// --- Promotion gate ------------------------------------------------------------

const grounded = { ok: true } as const;
const survived = { verdict: "SURVIVED" as const, reason: "every ground fails" };
const killed = { verdict: "KILLED" as const, reason: "owner-only" };

describe("promote — PURSUE requires grounding AND refuter survival", () => {
  it("never promotes without surviving the refuter (dry-run caps at awaiting)", () => {
    expect(promote({ grounding: grounded, refutation: null })).toEqual({
      verdict: "DROP",
      reason: "grounded but awaiting independent refuter pass (dry-run)",
    });
  });

  it("drops a killed finding with the refuter's reason", () => {
    expect(promote({ grounding: grounded, refutation: killed })).toEqual({
      verdict: "DROP",
      reason: "killed by independent refuter: owner-only",
    });
  });

  it("PURSUEs only grounded + survived", () => {
    expect(promote({ grounding: grounded, refutation: survived })).toEqual({
      verdict: "PURSUE",
      reason: "survived independent refuter + citation grounded",
    });
  });

  it("grounds before refutation matters: ungrounded never reaches PURSUE even if survived", () => {
    const result = promote({
      grounding: { ok: false, reason: "evidence not locatable in closure" },
      refutation: survived,
    });
    expect(result.verdict).toBe("DROP");
    expect(result.reason).toContain("evidence not locatable in closure");
  });
});

describe("advisorySummary — metadata only", () => {
  it("summarizes adverse model claims without gating anything", () => {
    const finding = auditFindingSchema.parse({
      title: "t",
      unprivilegedReachable: false,
      recoverableUnder1hr: true,
      inScope: false,
      duplicateOf: "C4 H-03",
    });
    const summary = advisorySummary(finding);
    for (const fragment of ["privileged-gated", "recoverable", "out of scope", "duplicate"]) {
      expect(summary).toContain(fragment);
    }
  });
});
