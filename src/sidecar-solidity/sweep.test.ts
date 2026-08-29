import { describe, it, expect, vi } from "vitest";
import {
  buildDedupedPursueMarkdown,
  buildPursueMarkdown,
  buildSweepSummary,
  enumerateFirstPartyEntries,
  globToRegExp,
  isInterfaceOnlyFile,
  parseEntriesFromFile,
  pursueFindingDedupKey,
  runPool,
  runSweepAudits,
  sanitizeEntryPath,
  type AuditEntryResult,
  type EntryPursueFindings,
} from "./sweep.js";
import { auditFindingSchema, type AuditFinding } from "./finding-schema.js";
import type { ScoredFinding } from "./run.js";
import type { ClosureResult } from "./closure.js";

// --- parseEntriesFromFile -----------------------------------------------------

describe("parseEntriesFromFile", () => {
  it("keeps repo-relative paths, ignoring blanks and # comments", () => {
    const text = `# entry points\ncontracts/A.sol\n\n  \ncontracts/B.sol\n# contracts/Excluded.sol\ncontracts/C.sol  \n`;
    expect(parseEntriesFromFile(text)).toEqual([
      "contracts/A.sol",
      "contracts/B.sol",
      "contracts/C.sol",
    ]);
  });

  it("returns empty for an all-comment/blank file", () => {
    expect(parseEntriesFromFile("# nothing here\n\n   \n")).toEqual([]);
  });

  it("trims trailing whitespace per line", () => {
    expect(parseEntriesFromFile("contracts/A.sol   \r\n")).toEqual(["contracts/A.sol"]);
  });
});

// --- sanitizeEntryPath ---------------------------------------------------------

describe("sanitizeEntryPath", () => {
  it("replaces slashes and non-safe characters with underscore", () => {
    expect(sanitizeEntryPath("contracts/smart-contract-wallet/SmartAccount.sol")).toBe(
      "contracts_smart-contract-wallet_SmartAccount.sol",
    );
  });

  it("leaves already-safe characters alone", () => {
    expect(sanitizeEntryPath("A.B-c_1.sol")).toBe("A.B-c_1.sol");
  });
});

// --- isInterfaceOnlyFile / globToRegExp -----------------------------------------

describe("isInterfaceOnlyFile", () => {
  it("is true for a file that declares only interfaces", () => {
    expect(isInterfaceOnlyFile("interface IFoo {\n  function bar() external;\n}\n")).toBe(true);
  });

  it("is false when a contract or library is also declared", () => {
    expect(isInterfaceOnlyFile("interface IFoo {}\ncontract Foo is IFoo {}\n")).toBe(false);
    expect(isInterfaceOnlyFile("library LibFoo {}\n")).toBe(false);
  });

  it("is false when there is no interface at all", () => {
    expect(isInterfaceOnlyFile("contract Foo {}\n")).toBe(false);
  });
});

describe("globToRegExp", () => {
  it("matches a single-segment wildcard", () => {
    expect(globToRegExp("contracts/*.sol").test("contracts/Foo.sol")).toBe(true);
    expect(globToRegExp("contracts/*.sol").test("contracts/nested/Foo.sol")).toBe(false);
  });

  it("matches ** across directories", () => {
    const re = globToRegExp("contracts/**/*.sol");
    expect(re.test("contracts/a/b/Foo.sol")).toBe(true);
    expect(re.test("contracts/Foo.sol")).toBe(true);
  });
});

// --- enumerateFirstPartyEntries (issue #178: sweep by default) --------------

describe("enumerateFirstPartyEntries", () => {
  it("selects first-party contract files, excluding test/mock/library/interface-only", async () => {
    const tree = new Map<string, string>([
      ["src/IndexFactory.sol", "contract IndexFactory {}\n"],
      ["src/RelativeIndexHook.sol", "contract RelativeIndexHook {}\n"],
      ["src/IIndex.sol", "interface IIndex { function x() external; }\n"], // interface-only
      ["lib/oz/ERC20.sol", "contract ERC20 {}\n"], // library
      ["node_modules/@oz/Ownable.sol", "contract Ownable {}\n"], // library
      ["test/Index.t.sol", "contract IndexTest {}\n"], // test
      ["script/Deploy.s.sol", "contract Deploy {}\n"], // script dir
    ]);
    const entries = await enumerateFirstPartyEntries({
      allPaths: [...tree.keys()],
      readFile: async (p) => tree.get(p) ?? "",
    });
    expect(entries).toEqual(["src/IndexFactory.sol", "src/RelativeIndexHook.sol"]);
  });

  it("returns [] when nothing first-party is present", async () => {
    const entries = await enumerateFirstPartyEntries({
      allPaths: ["lib/oz/ERC20.sol"],
      readFile: async () => "contract ERC20 {}\n",
    });
    expect(entries).toEqual([]);
  });
});

// --- runPool ---------------------------------------------------------------

describe("runPool", () => {
  it("runs every item and preserves result order", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await runPool(items, 2, async (n) => n * 10);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it("never exceeds the concurrency cap", async () => {
    const items = Array.from({ length: 8 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;
    await runPool(items, 3, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("processes all items even with concurrency greater than item count", async () => {
    const results = await runPool([1, 2], 10, async (n) => n);
    expect(results).toEqual([1, 2]);
  });
});

// --- runSweepAudits (per-entry error isolation) -----------------------------

function fakeClosure(): ClosureResult {
  return {
    blocks: [],
    roles: new Map(),
    implOf: new Map(),
    externalUnresolved: [],
    unresolvedEdges: [],
    bytes: 0,
    truncated: false,
    evicted: [],
    evictedFirstParty: [],
    entryOverflow: false,
  };
}

function fakeFinding(overrides: Partial<AuditFinding> = {}): AuditFinding {
  return auditFindingSchema.parse({
    title: "example finding",
    severity: "high",
    confidence: "high",
    evidence: [{ path: "contracts/A.sol", startLine: 1, endLine: 2 }],
    reasoning: "example reasoning",
    unprivilegedReachable: true,
    inScope: true,
    ...overrides,
  });
}

function fakeAuditResult(pursue: number, drop: number): AuditEntryResult {
  const scored: ScoredFinding[] = [
    ...Array.from({ length: pursue }, (_, i) => ({
      finding: fakeFinding({ title: `pursue-${i}` }),
      verdict: "PURSUE" as const,
      reason: "grounded + survived",
      advisory: "no adverse advisory factors",
    })),
    ...Array.from({ length: drop }, (_, i) => ({
      finding: fakeFinding({ title: `drop-${i}` }),
      verdict: "DROP" as const,
      reason: "killed by refuter",
      advisory: "no adverse advisory factors",
    })),
  ];
  return {
    entries: ["contracts/Entry.sol"],
    closure: fakeClosure(),
    result: {
      prompt: "prompt",
      findings: scored.map((s) => s.finding),
      scored,
      pursueCount: pursue,
      droppedCount: drop,
      rejectedRaw: [],
      truncated: false,
      crossFileDependencies: [],
      resolvedDependencies: [],
      focusedPrompts: [],
    },
  };
}

describe("runSweepAudits", () => {
  it("records a failing entry as an error without aborting the rest", async () => {
    const auditFn = vi.fn(async (entry: string) => {
      if (entry === "contracts/Bad.sol") {
        throw new Error("boom: model call failed");
      }
      return fakeAuditResult(1, 0);
    });

    const outcomes = await runSweepAudits({
      entries: ["contracts/Good1.sol", "contracts/Bad.sol", "contracts/Good2.sol"],
      concurrency: 2,
      auditFn,
    });

    expect(auditFn).toHaveBeenCalledTimes(3);
    const byEntry = new Map(outcomes.map((o) => [o.outcome.entry, o]));
    expect(byEntry.get("contracts/Good1.sol")?.outcome.status).toBe("ran");
    expect(byEntry.get("contracts/Good2.sol")?.outcome.status).toBe("ran");
    const bad = byEntry.get("contracts/Bad.sol");
    expect(bad?.outcome.status).toBe("error");
    expect(bad?.outcome.error).toContain("boom");
    expect(bad?.closure).toBeNull();
    expect(bad?.result).toBeNull();
  });

  it("respects the concurrency cap across many entries", async () => {
    const entries = Array.from({ length: 10 }, (_, i) => `contracts/E${i}.sol`);
    let inFlight = 0;
    let maxInFlight = 0;
    const auditFn = vi.fn(async (_entry: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return fakeAuditResult(0, 1);
    });

    const outcomes = await runSweepAudits({ entries, concurrency: 2, auditFn });
    expect(outcomes).toHaveLength(10);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});

// --- buildSweepSummary (aggregate rollup) -----------------------------------

describe("buildSweepSummary", () => {
  it("counts PURSUE/DROP/errors correctly across mixed outcomes", () => {
    const summary = buildSweepSummary({
      ranAt: "2026-08-27T00:00:00.000Z",
      live: true,
      target: "/tmp/target",
      concurrency: 2,
      outcomes: [
        { entry: "A.sol", status: "ran", pursue: 2, drop: 1, findings: 3, truncated: false },
        { entry: "B.sol", status: "ran", pursue: 0, drop: 3, findings: 3, truncated: false },
        {
          entry: "C.sol",
          status: "error",
          pursue: 0,
          drop: 0,
          findings: 0,
          truncated: false,
          error: "boom",
        },
      ],
    });
    expect(summary.totals).toEqual({ entries: 3, pursue: 2, drop: 4, errors: 1 });
    expect(summary.entries).toHaveLength(3);
  });
});

// --- buildPursueMarkdown -----------------------------------------------------

describe("buildPursueMarkdown", () => {
  it("reports zero PURSUE findings cleanly", () => {
    const md = buildPursueMarkdown([]);
    expect(md).toContain("0 finding(s) across 0 entry(ies)");
    expect(md).toContain("No PURSUE findings.");
  });

  it("sorts entries with the most/severest PURSUE first", () => {
    const scoredOne: ScoredFinding = {
      finding: fakeFinding({ title: "one-high", severity: "high" }),
      verdict: "PURSUE",
      reason: "grounded + survived",
      advisory: "no adverse advisory factors",
    };
    const scoredTwoCritical: ScoredFinding = {
      finding: fakeFinding({ title: "two-critical", severity: "critical" }),
      verdict: "PURSUE",
      reason: "grounded + survived",
      advisory: "no adverse advisory factors",
    };
    const scoredTwoLow: ScoredFinding = {
      finding: fakeFinding({ title: "two-low", severity: "low" }),
      verdict: "PURSUE",
      reason: "grounded + survived",
      advisory: "no adverse advisory factors",
    };
    const dropped: ScoredFinding = {
      finding: fakeFinding({ title: "dropped" }),
      verdict: "DROP",
      reason: "killed",
      advisory: "no adverse advisory factors",
    };

    const entries: EntryPursueFindings[] = [
      { entry: "SmallEntry.sol", scored: [scoredOne] },
      { entry: "BigEntry.sol", scored: [scoredTwoCritical, scoredTwoLow, dropped] },
      { entry: "NoneEntry.sol", scored: [dropped] },
    ];

    const md = buildPursueMarkdown(entries);
    expect(md).toContain("3 finding(s) across 2 entry(ies)");
    const bigIdx = md.indexOf("BigEntry.sol");
    const smallIdx = md.indexOf("SmallEntry.sol");
    expect(bigIdx).toBeGreaterThanOrEqual(0);
    expect(smallIdx).toBeGreaterThan(bigIdx); // BigEntry (2 PURSUE) sorts before SmallEntry (1)
    expect(md).not.toContain("NoneEntry.sol"); // no PURSUE -> excluded
    expect(md).toContain("evidence: `contracts/A.sol:1-2`");
  });
});

// --- pursueFindingDedupKey / buildDedupedPursueMarkdown (issue #178) ----------

const ev = (
  path: string,
  startLine: number,
  endLine: number,
): AuditFinding["evidence"][number] => ({ path, startLine, endLine, symbol: null, quote: null });

describe("pursueFindingDedupKey", () => {
  it("dedupes the same bug (same title + start anchor) even if the end line was re-anchored", () => {
    const a = fakeFinding({ title: "epoch cap inverted", evidence: [ev("src/Hook.sol", 42, 50)] });
    const b = fakeFinding({
      title: "Epoch  Cap  Inverted", // same title, case/space-normalized
      evidence: [ev("src/Hook.sol", 42, 99)], // end re-anchored — startLine is the key
    });
    expect(pursueFindingDedupKey(a)).toBe(pursueFindingDedupKey(b));
  });

  it("does NOT collapse distinct bugs sharing a start line (title is part of the key)", () => {
    const a = fakeFinding({
      title: "missing auth check",
      evidence: [ev("src/Vault.sol", 120, 120)],
    });
    const b = fakeFinding({
      title: "accounting underflow", // different bug, same packed line
      evidence: [ev("src/Vault.sol", 120, 122)],
    });
    expect(pursueFindingDedupKey(a)).not.toBe(pursueFindingDedupKey(b));
  });

  it("falls back to normalized title when no anchor is present", () => {
    const a = fakeFinding({ title: "  Holder  Trap  ", evidence: [] });
    const b = fakeFinding({ title: "holder trap", evidence: [] });
    expect(pursueFindingDedupKey(a)).toBe(pursueFindingDedupKey(b));
    expect(pursueFindingDedupKey(a)).toContain("title:");
  });
});

describe("buildDedupedPursueMarkdown", () => {
  const pursue = (
    title: string,
    severity: AuditFinding["severity"],
    line: number,
  ): ScoredFinding => ({
    finding: fakeFinding({ title, severity, evidence: [ev("src/Hook.sol", line, line + 1)] }),
    verdict: "PURSUE",
    reason: "grounded + survived",
    advisory: "no adverse advisory factors",
  });

  it("collapses one bug reached from two entries into a single union row", () => {
    const entries: EntryPursueFindings[] = [
      { entry: "src/IndexFactory.sol", scored: [pursue("epoch cap inverted", "high", 42)] },
      { entry: "src/RelativeIndexHook.sol", scored: [pursue("epoch cap inverted", "high", 42)] },
    ];
    const md = buildDedupedPursueMarkdown(entries);
    expect(md).toContain("1 unique finding(s) (2 raw across 2 entry(ies))");
    // one row, listing BOTH surfacing entries
    expect(md.match(/epoch cap inverted/gu)).toHaveLength(1);
    expect(md).toContain("surfaced from: src/IndexFactory.sol, src/RelativeIndexHook.sol");
  });

  it("keeps distinct bugs separate and sorts by severity", () => {
    const entries: EntryPursueFindings[] = [
      { entry: "src/A.sol", scored: [pursue("low bug", "low", 1)] },
      { entry: "src/B.sol", scored: [pursue("crit bug", "critical", 2)] },
    ];
    const md = buildDedupedPursueMarkdown(entries);
    expect(md).toContain("2 unique finding(s)");
    expect(md.indexOf("crit bug")).toBeLessThan(md.indexOf("low bug")); // critical first
  });

  it("reports zero cleanly", () => {
    expect(buildDedupedPursueMarkdown([])).toContain("0 unique finding(s)");
    expect(buildDedupedPursueMarkdown([])).toContain("No PURSUE findings.");
  });
});

describe("buildSweepSummary — PoC coverage counters (#179 §4)", () => {
  const outcome = (
    o: Partial<import("./sweep.js").SweepEntryOutcome>,
  ): import("./sweep.js").SweepEntryOutcome => ({
    entry: "E.sol",
    status: "ran",
    pursue: 1,
    drop: 0,
    findings: 1,
    truncated: false,
    ...o,
  });

  it("omits PoC totals entirely on a non-`--poc` sweep (byte-identical)", () => {
    const s = buildSweepSummary({
      ranAt: "t",
      live: true,
      target: "x",
      concurrency: 1,
      outcomes: [outcome({}), outcome({ entry: "F.sol" })],
    });
    expect("confirmed" in s.totals).toBe(false);
    expect("pocAttempted" in s.totals).toBe(false);
  });

  it("sums PoC counters when the --poc stage ran", () => {
    const s = buildSweepSummary({
      ranAt: "t",
      live: true,
      target: "x",
      concurrency: 1,
      outcomes: [
        outcome({
          entry: "A.sol",
          confirmed: 1,
          pocAttempted: 2,
          pocExecuted: 1,
          pocSkippedInfra: 1,
        }),
        outcome({
          entry: "B.sol",
          confirmed: 0,
          pocAttempted: 3,
          pocExecuted: 0,
          pocSkippedInfra: 3,
        }),
      ],
    });
    expect(s.totals.confirmed).toBe(1);
    expect(s.totals.pocAttempted).toBe(5);
    expect(s.totals.pocExecuted).toBe(1);
    expect(s.totals.pocSkippedInfra).toBe(4);
  });
});
