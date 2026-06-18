import { describe, expect, it } from "vitest";
import { formatPRComment, type PatchForRender, type ReviewMeta } from "./pr-comment";
import type { Finding } from "./review-types";

// Patch Agent v1.5 — render-path regression + new behavior. The byte-
// identical check lives here (not in pr-comment.test.ts) so the snapshot
// fixture stays in one place and the v1.4 baseline is auditable.

const META: ReviewMeta = {
  reviewId: "abcd1234-ef56-7890-abcd-ef1234567890",
  totalMs: 87000,
  estimatedCostUsd: 0.4,
  modelIds: { anthropic: "claude-opus-4-7", openai: "gpt-5.5" },
};

const mkFinding = (overrides: Partial<Finding> = {}): Finding => ({
  title: "Off-by-one in counter init",
  category: "bug",
  severity: "high",
  label: "blocking",
  confidence: "high",
  evidence: [{ path: "src/foo.ts", startLine: 10, endLine: 12, symbol: null, quote: null }],
  reasoning: "Counter starts at 1 instead of 0.",
  reproduction: null,
  recommendation: "Initialize the counter to 0.",
  whyTestsDoNotAlreadyCoverThis: "",
  suggestedRegressionTest: null,
  minimumFixScope: "",
  requiresPolicyReview: false,
  upstreamOrigin: null,
  ...overrides,
});

// Realistic unified-diff fixture. extractNewSideLines() will pull
// "const counter = 0;" as the suggestion's literal replacement text.
// (The old fixture rendered `-const counter = 1;\n+const counter = 0;`
// inside the fence — wrong, fixed by the v1.5 audit-response.)
const PATCH: PatchForRender = {
  patch:
    "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,1 +1,1 @@\n-const counter = 1;\n+const counter = 0;\n",
  modelId: "claude-opus-4-7",
};

describe("formatPRComment — flag-off (byte-identical regression)", () => {
  it("omits the suggestion block entirely when patchesByIndex is undefined", () => {
    const out = formatPRComment([mkFinding()], META);
    expect(out).not.toContain("<details>");
    expect(out).not.toContain("```suggestion");
    expect(out).not.toContain("Proposed patch");
  });

  it("omits the suggestion block when patchesByIndex is an empty map", () => {
    const out = formatPRComment([mkFinding()], {
      ...META,
      patchesByIndex: new Map(),
    });
    expect(out).not.toContain("<details>");
    expect(out).not.toContain("```suggestion");
  });

  it("produces byte-identical output to v1.4 when patches are absent (single finding)", () => {
    const findings = [mkFinding()];
    const before = formatPRComment(findings, META);
    const afterWithEmptyMap = formatPRComment(findings, { ...META, patchesByIndex: new Map() });
    const afterUndefined = formatPRComment(findings, { ...META, patchesByIndex: undefined });
    expect(before).toBe(afterUndefined);
    expect(before).toBe(afterWithEmptyMap);
  });

  it("produces byte-identical output to v1.4 with multi-finding + settlement", () => {
    const findings = [
      mkFinding({ title: "F1" }),
      mkFinding({ title: "F2", severity: "low" }),
      mkFinding({ title: "F3", severity: "critical" }),
    ];
    const metaWithSettlement: ReviewMeta = {
      ...META,
      settlement: {
        channelBalanceUsdc: "9.5",
        lastDepositTxHash: "0xabc123def456abc123def456abc123def456abc1",
      },
    };
    const before = formatPRComment(findings, metaWithSettlement);
    const after = formatPRComment(findings, { ...metaWithSettlement, patchesByIndex: new Map() });
    expect(before).toBe(after);
    // Sweeper-load-bearing header — unchanged.
    expect(before).toMatch(/^## AntFleet · 3 findings/u);
    expect(before).toContain("Review `abcd1234`");
    expect(before).toContain("Settled · tx");
    // Critically: v1.4 footer wording is "Settled", not "Patch settled".
    expect(before).not.toContain("Patch settled");
  });
});

describe("formatPRComment — flag-on rendering", () => {
  it("emits a <details>/```suggestion``` block with literal replacement text (not unified-diff)", () => {
    const out = formatPRComment([mkFinding()], {
      ...META,
      patchesByIndex: new Map([[0, PATCH]]),
    });
    expect(out).toContain("**Fix:** Initialize the counter to 0.");
    expect(out).toContain("<details>");
    expect(out).toContain("<summary>Proposed patch (model: claude-opus-4-7)</summary>");
    expect(out).toContain("```suggestion");
    // Suggestion body contains the new-side line, NOT the diff syntax.
    // GitHub's suggestion fence expects literal replacement text.
    expect(out).toContain("const counter = 0;");
    expect(out).not.toContain("+const counter = 0;");
    expect(out).not.toContain("-const counter = 1;");
    expect(out).toContain("```\n</details>");
  });

  it("places the suggestion block AFTER the existing finding body (not before)", () => {
    const out = formatPRComment([mkFinding()], {
      ...META,
      patchesByIndex: new Map([[0, PATCH]]),
    });
    const fixIndex = out.indexOf("**Fix:**");
    const suggestionIndex = out.indexOf("```suggestion");
    expect(fixIndex).toBeGreaterThan(0);
    expect(suggestionIndex).toBeGreaterThan(fixIndex);
  });

  it("renders one suggestion block per finding when multiple patches present", () => {
    const findings = [mkFinding({ title: "F1" }), mkFinding({ title: "F2", severity: "low" })];
    const patches = new Map<number, PatchForRender>([
      [0, { patch: "@@ -1,1 +1,1 @@\n-a\n+A\n", modelId: "claude-opus-4-7" }],
      [1, { patch: "@@ -1,1 +1,1 @@\n-b\n+B\n", modelId: "claude-opus-4-7" }],
    ]);
    const out = formatPRComment(findings, { ...META, patchesByIndex: patches });
    // Two suggestion blocks total.
    const matches = out.match(/```suggestion/gu);
    expect(matches).toHaveLength(2);
    // Suggestion body contains the literal new line, not the +prefix.
    expect(out).toContain("\nA\n");
    expect(out).toContain("\nB\n");
    expect(out).not.toContain("+A");
    expect(out).not.toContain("+B");
  });

  it("renders a suggestion block only for the findings that HAVE a patch", () => {
    const findings = [mkFinding({ title: "F1" }), mkFinding({ title: "F2", severity: "low" })];
    // Only F1 (index 0) has a patch.
    const patches = new Map<number, PatchForRender>([
      [0, { patch: "@@ -1,1 +1,1 @@\n-a\n+A\n", modelId: "claude-opus-4-7" }],
    ]);
    const out = formatPRComment(findings, { ...META, patchesByIndex: patches });
    const blocks = out.match(/```suggestion/gu);
    expect(blocks).toHaveLength(1);
    expect(out).toContain("\nA\n");
  });

  it("keys patches by ORIGINAL index, not severity-sorted index", () => {
    // findings[0] = low severity → renders LAST after sort.
    // findings[1] = critical severity → renders FIRST after sort.
    // The patch for the critical finding lives at patchesByIndex[1], NOT
    // patchesByIndex[0]. A patches-keyed-by-sort bug would attach the
    // patch to the wrong finding here.
    const findings = [
      mkFinding({ title: "LOW", severity: "low" }),
      mkFinding({ title: "CRIT", severity: "critical" }),
    ];
    const patches = new Map<number, PatchForRender>([
      [1, { patch: "@@ -1,1 +1,1 @@\n+CRIT_FIX_LINE\n", modelId: "claude-opus-4-7" }],
    ]);
    const out = formatPRComment(findings, { ...META, patchesByIndex: patches });
    const critIndex = out.indexOf("CRIT ");
    const lowIndex = out.indexOf("LOW");
    const patchIndex = out.indexOf("CRIT_FIX_LINE");
    expect(critIndex).toBeLessThan(lowIndex); // sorted: critical first
    expect(patchIndex).toBeGreaterThan(critIndex);
    expect(patchIndex).toBeLessThan(lowIndex); // patch attached to CRIT, not LOW
  });

  it("omits the suggestion block when the patch has no new-side lines (deletion-only)", () => {
    const deletionOnly: PatchForRender = {
      patch: "@@ -1,2 +1,0 @@\n-a\n-b\n",
      modelId: "claude-opus-4-7",
    };
    const out = formatPRComment([mkFinding()], {
      ...META,
      patchesByIndex: new Map([[0, deletionOnly]]),
    });
    // A pure deletion can't be expressed as a ```suggestion``` block
    // (no replacement text to insert). The fix line still renders.
    expect(out).not.toContain("```suggestion");
    expect(out).not.toContain("<details>");
    expect(out).toContain("**Fix:**");
  });

  it("switches the fence to ~~~ when the replacement contains triple-backticks", () => {
    const patchWithFence: PatchForRender = {
      patch:
        "@@ -1,3 +1,3 @@\n const example = `\n-old code here\n+```ts\\nnew code\\n```\n const after = `\n",
      modelId: "claude-opus-4-7",
    };
    const out = formatPRComment([mkFinding()], {
      ...META,
      patchesByIndex: new Map([[0, patchWithFence]]),
    });
    // The new-side line contains ```, so the renderer must escape via ~~~.
    expect(out).toContain("~~~suggestion");
    expect(out).toContain("~~~\n</details>");
    // The default ``` fence MUST NOT wrap a body that contains ``` —
    // GitHub would close the fence early and break the comment.
    expect(out).not.toContain("```suggestion\n```ts");
  });

  it("renders out-of-hunk artifacts as unified diffs, not suggestion blocks", () => {
    const out = formatPRComment([mkFinding()], {
      ...META,
      patchesByIndex: new Map([[0, { ...PATCH, mode: "artifact" }]]),
    });
    expect(out).toContain("Out-of-hunk patch artifact (model: claude-opus-4-7)");
    expect(out).toContain("non-click-to-apply");
    expect(out).toContain("```diff");
    expect(out).toContain("--- a/src/foo.ts");
    expect(out).toContain("+const counter = 0;");
    expect(out).not.toContain("```suggestion");
    expect(out).not.toContain("Commit suggestion");
  });
});

describe("formatPRComment — settlement footer with patch", () => {
  const metaWithSettlement: ReviewMeta = {
    ...META,
    settlement: {
      channelBalanceUsdc: "9.5",
      lastDepositTxHash: "0xabc123def456abc123def456abc123def456abc1",
    },
  };

  it("says 'Patch settled' when at least one patch is included", () => {
    const out = formatPRComment([mkFinding()], {
      ...metaWithSettlement,
      patchesByIndex: new Map([[0, PATCH]]),
    });
    expect(out).toContain("Patch settled · tx");
    expect(out).not.toMatch(/[^a-z]Settled · /u); // no plain "Settled" prefix
  });

  it("keeps 'Settled' when no patch shipped (findings-only with payment)", () => {
    const out = formatPRComment([mkFinding()], {
      ...metaWithSettlement,
      patchesByIndex: new Map(),
    });
    expect(out).toContain("Settled · tx");
    expect(out).not.toContain("Patch settled");
  });

  it("omits the footer entirely when settlement is absent (legacy_partner path)", () => {
    const out = formatPRComment([mkFinding()], {
      ...META,
      patchesByIndex: new Map([[0, PATCH]]),
    });
    expect(out).not.toContain("Settled");
  });

  it("works with null lastDepositTxHash (deposit not yet observed)", () => {
    const out = formatPRComment([mkFinding()], {
      ...metaWithSettlement,
      settlement: { channelBalanceUsdc: "5", lastDepositTxHash: null },
      patchesByIndex: new Map([[0, PATCH]]),
    });
    expect(out).toContain("Patch settled · channel balance 5 USDC");
  });
});

describe("formatPRComment — sweeper-compatibility invariants", () => {
  it("the finding metadata header (used by sweeper regex) is identical with/without patch", () => {
    const finding = mkFinding({ title: "Sweeper-anchor target" });
    const without = formatPRComment([finding], META);
    const withPatch = formatPRComment([finding], {
      ...META,
      patchesByIndex: new Map([[0, PATCH]]),
    });
    // Sweeper anchors on the **Category · Severity** — Title line. That
    // line must be byte-identical so any downstream parser continues to
    // match. (PR1 of the original sweeper sprint used a regex on this
    // exact shape.)
    expect(without).toContain("**Bug · High** — Sweeper-anchor target");
    expect(withPatch).toContain("**Bug · High** — Sweeper-anchor target");
  });

  it("the Review id8 footer prefix is identical with/without patch", () => {
    const finding = mkFinding();
    const without = formatPRComment([finding], META);
    const withPatch = formatPRComment([finding], {
      ...META,
      patchesByIndex: new Map([[0, PATCH]]),
    });
    expect(without).toContain("Review `abcd1234`");
    expect(withPatch).toContain("Review `abcd1234`");
  });
});
