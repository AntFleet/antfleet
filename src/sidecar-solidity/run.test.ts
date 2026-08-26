import { describe, it, expect } from "vitest";
import { runFinder, type FinderRunResult } from "./run.js";
import { FIXTURE_HINT_STRINGS } from "./closure.test.js";

const NEUTRAL_RULES = `High severity: unprivileged extraction or permanent freeze of protocol funds.
Out of scope: UI, off-chain config, gas griefing.
Recovery policy: team measures can cap damage within ~1 hour.`;

const baseInput = {
  projectName: "fixture",
  entries: ["contracts/Wallet.sol"],
  files: [{ path: "contracts/Wallet.sol", contents: "contract Wallet {}" }],
  programRules: NEUTRAL_RULES,
} as const;

describe("runFinder — dry-run (no model call)", () => {
  it("omitting callModel never invokes the transport and returns the rendered prompt", async () => {
    const result = await runFinder(baseInput, undefined);
    expect(result.findings).toEqual([]);
    expect(result.scored).toEqual([]);
    expect(result.prompt).toContain("OBJECTIVE");
    expect(result.prompt).toContain(NEUTRAL_RULES);
  });
});

describe("runFinder — live path with injected fake model", () => {
  const privilegedFinding = {
    title: "pauser can sweep treasury",
    category: "security",
    severity: "high",
    confidence: "high",
    evidence: [
      { path: "contracts/Wallet.sol", startLine: 10, endLine: 12, symbol: null, quote: null },
    ],
    reasoning: "onlyRole(PAUSER) moves all funds out",
    triggerRole: "onlyRole(PAUSER)",
    preconditions: "none",
    unprivilegedReachable: false,
    recoverableUnder1hr: true,
    inScope: true,
    duplicateOf: null,
  };

  it("parses and DROPS a privileged-only finding with its reason end-to-end", async () => {
    const result = await runFinder(baseInput, async () => ({
      findings: [privilegedFinding],
      inspected: { files: [], notes: [] },
    }));
    expect(result.findings).toHaveLength(1);
    expect(result.pursueCount).toBe(0);
    expect(result.droppedCount).toBe(1);
    const scored = result.scored[0];
    if (scored === undefined) throw new Error("expected one scored finding");
    expect(scored.verdict).toBe("DROP");
    expect(scored.reason).toContain("privileged");
  });

  it("PURSUEs only an all-four-factors finding at correct severity", async () => {
    const result = await runFinder(baseInput, async () => ({
      findings: [
        {
          ...privilegedFinding,
          title: "uninitialized init allows takeover",
          triggerRole: "any unprivileged EOA",
          unprivilegedReachable: true,
          recoverableUnder1hr: false,
        },
      ],
      inspected: { files: [], notes: [] },
    }));
    expect(result.pursueCount).toBe(1);
  });

  it("throws LOUDLY when the findings key is entirely absent (no silent zeros)", async () => {
    // Live-e2e lesson: whole-array .catch([]) turned a 5k-token response into
    // "0 findings" silently. A structurally-broken payload must fail visibly.
    await expect(runFinder(baseInput, async () => ({ nonsense: true }))).rejects.toThrow(
      /lenient parse/,
    );
  });

  it("degrades ONE malformed finding without losing its well-formed siblings", async () => {
    const good = {
      title: "good finding",
      severity: "high",
      confidence: "high",
      evidence: [{ path: "W.sol", startLine: 1, endLine: 2, symbol: null, quote: null }],
      reasoning: "r",
      triggerRole: "any EOA",
      preconditions: "p",
      unprivilegedReachable: true,
      recoverableUnder1hr: false,
      inScope: true,
      duplicateOf: null,
    };
    const result = await runFinder(baseInput, async () => ({
      findings: [good, { nope: true, evidence: "not-an-array" }],
    }));
    expect(result.findings).toHaveLength(2); // sibling survives; bad one salvaged
    const salvaged = result.findings[1];
    expect(salvaged?.title).toBe("(unparseable finding)");
    expect(result.scored[1]?.verdict).toBe("DROP"); // salvaged placeholder drops conservatively
  });

  it("throws on output that fails even lenient parsing", async () => {
    await expect(runFinder(baseInput, async () => "not an object")).rejects.toThrow(
      /lenient parse/,
    );
  });
});

describe("anti-contamination — the finder scaffold is target-agnostic", () => {
  it("rendered scaffold contains none of the fixture's known-bug hint strings", async () => {
    // Render with NO files/rules content so any hit would be scaffold leakage.
    const result: FinderRunResult = await runFinder(
      { projectName: "x", entries: [], files: [], programRules: "" },
      undefined,
    );
    for (const hint of FIXTURE_HINT_STRINGS) {
      expect(result.prompt.toLowerCase()).not.toContain(hint.toLowerCase());
    }
  });

  it("scaffold does not name entry-derived attack phrasing even when entries are set", async () => {
    const result = await runFinder({ ...baseInput, files: [], programRules: "" }, undefined);
    for (const hint of FIXTURE_HINT_STRINGS) {
      expect(result.prompt.toLowerCase()).not.toContain(hint.toLowerCase());
    }
  });
});
