import { describe, expect, it } from "vitest";
import {
  formatClosureReceipt,
  formatPRComment,
  formatSingleModelSection,
  type ReviewMeta,
} from "./pr-comment";
import type { Finding } from "./review-types";

const META: ReviewMeta = {
  reviewId: "abcd1234-ef56-7890-abcd-ef1234567890",
  totalMs: 87000,
  estimatedCostUsd: 0.4,
  modelIds: { anthropic: "claude-opus-4-7", openai: "gpt-5.5" },
};

const mkFinding = (overrides: Partial<Finding> = {}): Finding => ({
  title: "Title",
  category: "bug",
  severity: "medium",
  label: "blocking",
  confidence: "high",
  evidence: [{ path: "src/foo.ts", startLine: 10, endLine: 20, symbol: null, quote: null }],
  reasoning: "Reasoning text",
  reproduction: null,
  recommendation: "Recommendation text",
  whyTestsDoNotAlreadyCoverThis: "",
  suggestedRegressionTest: null,
  minimumFixScope: "",
  requiresPolicyReview: false,
  upstreamOrigin: null,
  ...overrides,
});

describe("formatPRComment", () => {
  it("returns empty string when no findings", () => {
    expect(formatPRComment([], META)).toBe("");
  });

  it("includes title, file:line, reasoning, and fix", () => {
    const out = formatPRComment([mkFinding()], META);
    expect(out).toContain("Title");
    expect(out).toContain("`src/foo.ts:10-20`");
    expect(out).toContain("> Reasoning text");
    expect(out).toContain("**Fix:** Recommendation text");
  });

  it("prefixes non-blocking labels on the fix line", () => {
    expect(formatPRComment([mkFinding({ label: "nit" })], META)).toContain(
      "**Fix:** **Nit:** Recommendation text",
    );
    expect(formatPRComment([mkFinding({ label: "optional" })], META)).toContain(
      "**Fix:** **Optional:** Recommendation text",
    );
    expect(formatPRComment([mkFinding({ label: "fyi" })], META)).toContain(
      "**Fix:** **FYI:** Recommendation text",
    );
    expect(formatPRComment([mkFinding({ label: "blocking" })], META)).toContain(
      "**Fix:** Recommendation text",
    );
  });

  it("uses singular 'finding' for 1, plural for >1", () => {
    expect(formatPRComment([mkFinding()], META)).toContain("1 finding\n");
    const two = formatPRComment([mkFinding(), mkFinding()], META);
    expect(two).toContain("2 findings\n");
  });

  it("orders findings critical → high → medium → low", () => {
    const out = formatPRComment(
      [
        mkFinding({ severity: "low", title: "LOW" }),
        mkFinding({ severity: "critical", title: "CRIT" }),
        mkFinding({ severity: "medium", title: "MED" }),
        mkFinding({ severity: "high", title: "HIGH" }),
      ],
      META,
    );
    const positions = ["CRIT", "HIGH", "MED", "LOW"].map((t) => out.indexOf(t));
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
    expect(positions.every((p) => p >= 0)).toBe(true);
  });

  it("title-cases severity and category in the header line", () => {
    const out = formatPRComment([mkFinding({ category: "security", severity: "critical" })], META);
    expect(out).toContain("**Security · Critical**");
  });

  it("renders a single-line file path with no range when startLine === endLine", () => {
    const out = formatPRComment(
      [
        mkFinding({
          evidence: [{ path: "a.ts", startLine: 5, endLine: 5, symbol: null, quote: null }],
        }),
      ],
      META,
    );
    expect(out).toContain("`a.ts:5`");
    expect(out).not.toContain("`a.ts:5-5`");
  });

  it("renders a path-only locator when startLine is null", () => {
    const out = formatPRComment(
      [
        mkFinding({
          evidence: [
            { path: "no-lines.ts", startLine: null, endLine: null, symbol: null, quote: null },
          ],
        }),
      ],
      META,
    );
    expect(out).toContain("`no-lines.ts`");
    expect(out).not.toMatch(/no-lines\.ts:/u);
  });

  it("truncates very long reasoning + recommendation with an ellipsis", () => {
    const long = "x".repeat(2000);
    const out = formatPRComment([mkFinding({ reasoning: long, recommendation: long })], META);
    expect(out.length).toBeLessThan(2 * long.length);
    expect(out).toMatch(/…/u);
  });

  it("includes the footer with reviewId prefix, model ids, timing, and cost", () => {
    const out = formatPRComment([mkFinding()], META);
    expect(out).toContain("`abcd1234`");
    expect(out).toContain("`claude-opus-4-7` + `gpt-5.5`");
    expect(out).toContain("(unanimous)");
    expect(out).toContain("87s");
    expect(out).toContain("~$0.40");
  });

  it("omits the settled-receipt footer when no settlement is supplied", () => {
    const out = formatPRComment([mkFinding()], META);
    expect(out).not.toContain("Settled ·");
    expect(out).not.toContain("basescan.org");
  });

  it("appends a settled-receipt footer with basescan link when settlement is supplied", () => {
    const txHash = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const out = formatPRComment([mkFinding()], {
      ...META,
      settlement: { channelBalanceUsdc: "4.500000", lastDepositTxHash: txHash },
    });
    expect(out).toContain("Settled ·");
    expect(out).toContain("channel balance 4.500000 USDC");
    expect(out).toContain(`https://basescan.org/tx/${txHash}`);
    // short hash form
    expect(out).toContain("`0xabcd…7890`");
  });

  it("omits the tx link when settlement has no lastDepositTxHash", () => {
    const out = formatPRComment([mkFinding()], {
      ...META,
      settlement: { channelBalanceUsdc: "3.000000", lastDepositTxHash: null },
    });
    expect(out).toContain("Settled · channel balance 3.000000 USDC");
    expect(out).not.toContain("basescan.org");
  });

  describe("Patch Agent v1.6 — click-apply suggestion swap", () => {
    const PATCH = {
      patch: [
        "--- a/src/foo.ts",
        "+++ b/src/foo.ts",
        "@@ -10,1 +10,1 @@",
        "-const x = 1;",
        "+const x = 2;",
        "",
      ].join("\n"),
      modelId: "claude-opus-4-7",
    };

    it("flag off + patch + single-line evidence → renders <details> block (v1.5 byte-identical)", () => {
      const finding = mkFinding({
        evidence: [{ path: "src/foo.ts", startLine: 10, endLine: 10, symbol: null, quote: null }],
      });
      const patches = new Map([[0, PATCH]]);
      const out = formatPRComment([finding], { ...META, patchesByIndex: patches });
      expect(out).toContain("<details>");
      expect(out).toContain("Proposed patch (model: claude-opus-4-7)");
      expect(out).toContain("```suggestion");
      expect(out).toContain("const x = 2;");
      expect(out).not.toContain("→ Proposed patch as a reviewable comment");
    });

    it("flag on + patch + single-line evidence → renders one-liner pointer, no <details>", () => {
      const finding = mkFinding({
        evidence: [{ path: "src/foo.ts", startLine: 10, endLine: 10, symbol: null, quote: null }],
      });
      const patches = new Map([[0, PATCH]]);
      const out = formatPRComment([finding], {
        ...META,
        patchesByIndex: patches,
        clickApplyEnabled: true,
      });
      expect(out).toContain(
        "→ Proposed patch as a reviewable comment below (click `Commit suggestion`)",
      );
      expect(out).not.toContain("<details>");
      expect(out).not.toContain("```suggestion");
    });

    it("flag on + patch + multi-line evidence → still renders <details> block (Q2 fallback)", () => {
      const finding = mkFinding({
        evidence: [{ path: "src/foo.ts", startLine: 10, endLine: 20, symbol: null, quote: null }],
      });
      const patches = new Map([[0, PATCH]]);
      const out = formatPRComment([finding], {
        ...META,
        patchesByIndex: patches,
        clickApplyEnabled: true,
      });
      expect(out).toContain("<details>");
      expect(out).toContain("```suggestion");
      expect(out).not.toContain("→ Proposed patch as a reviewable comment");
    });

    it("flag on + no patch → no suggestion subsection (no pointer, no details)", () => {
      const finding = mkFinding({
        evidence: [{ path: "src/foo.ts", startLine: 10, endLine: 10, symbol: null, quote: null }],
      });
      const out = formatPRComment([finding], { ...META, clickApplyEnabled: true });
      expect(out).not.toContain("<details>");
      expect(out).not.toContain("→ Proposed patch as a reviewable comment");
      expect(out).not.toContain("```suggestion");
    });

    it("settlement footer still says 'Patch settled' when click-apply on with patches", () => {
      const finding = mkFinding({
        evidence: [{ path: "src/foo.ts", startLine: 10, endLine: 10, symbol: null, quote: null }],
      });
      const patches = new Map([[0, PATCH]]);
      const out = formatPRComment([finding], {
        ...META,
        patchesByIndex: patches,
        clickApplyEnabled: true,
        settlement: { channelBalanceUsdc: "5.0", lastDepositTxHash: null },
      });
      expect(out).toContain("Patch settled");
    });
  });
});

describe("formatClosureReceipt", () => {
  const CLOSURE_SHA = "abc1234deadbeef5678901234567890abcdef1234";
  const ORIGINAL_URL =
    "https://github.com/Augustas11/krisskross_shops/pull/1#issuecomment-4467353797";

  const mkInput = (
    overrides: {
      finding?: Partial<Finding>;
      findingId?: string;
      originalCommentUrl?: string | null;
    } = {},
  ) => ({
    findingId: overrides.findingId ?? "83e79770-2",
    closureSha: CLOSURE_SHA,
    finding: mkFinding(overrides.finding ?? {}),
    owner: "Augustas11",
    repo: "krisskross_shops",
    // Use `in` so explicit null/empty passes through; ?? would coalesce
    // them away and we couldn't test the fallback-footer branch.
    originalCommentUrl:
      "originalCommentUrl" in overrides ? overrides.originalCommentUrl! : ORIGINAL_URL,
  });

  it("includes the finding id and the 7-char short SHA in the header", () => {
    const out = formatClosureReceipt(mkInput());
    expect(out).toContain("`83e79770-2`");
    expect(out).toContain("`abc1234`");
  });

  it("links the short SHA to the commit URL", () => {
    const out = formatClosureReceipt(mkInput());
    expect(out).toContain(`https://github.com/Augustas11/krisskross_shops/commit/${CLOSURE_SHA}`);
  });

  it("title-cases category and severity", () => {
    const out = formatClosureReceipt(
      mkInput({ finding: { category: "security", severity: "critical" } }),
    );
    expect(out).toContain("**Security · Critical**");
  });

  it("includes the file:line evidence path", () => {
    const out = formatClosureReceipt(
      mkInput({
        finding: {
          evidence: [
            { path: "src/admin.ts", startLine: 10, endLine: 22, symbol: null, quote: null },
          ],
        },
      }),
    );
    expect(out).toContain("`src/admin.ts:10-22`");
  });

  it("links back to the original comment when URL is provided", () => {
    const out = formatClosureReceipt(mkInput());
    expect(out).toContain(`[the AntFleet review](${ORIGINAL_URL})`);
  });

  it("omits the linkback (uses fallback footer) when original comment URL is null", () => {
    const out = formatClosureReceipt(mkInput({ originalCommentUrl: null }));
    expect(out).toContain("Receipt automated by AntFleet.");
    expect(out).not.toContain("Originally flagged");
  });

  it("omits the linkback when original comment URL is empty string", () => {
    const out = formatClosureReceipt(mkInput({ originalCommentUrl: "" }));
    expect(out).toContain("Receipt automated by AntFleet.");
    expect(out).not.toContain("Originally flagged");
  });

  it("renders single-line file path when startLine === endLine", () => {
    const out = formatClosureReceipt(
      mkInput({
        finding: {
          evidence: [{ path: "src/a.ts", startLine: 5, endLine: 5, symbol: null, quote: null }],
        },
      }),
    );
    expect(out).toContain("`src/a.ts:5`");
    expect(out).not.toContain("`src/a.ts:5-5`");
  });

  it("renders path-only locator when startLine is null", () => {
    const out = formatClosureReceipt(
      mkInput({
        finding: {
          evidence: [
            { path: "no-lines.ts", startLine: null, endLine: null, symbol: null, quote: null },
          ],
        },
      }),
    );
    expect(out).toContain("`no-lines.ts`");
    expect(out).not.toMatch(/no-lines\.ts:/u);
  });
});

// ===========================================================================
// Step 0.5 — precision feedback (flag-gated affordance)
// ===========================================================================

describe("formatPRComment — Step 0.5 precision feedback", () => {
  const FINDING_ID_0 = `${META.reviewId}-0`;
  const FINDING_ID_1 = `${META.reviewId}-1`;

  it("flag OFF (default): output is byte-identical to pre-Step-0.5", () => {
    const finding = mkFinding();
    const withFlag = formatPRComment([finding], {
      ...META,
      precisionFeedbackEnabled: false,
    });
    const withoutFlag = formatPRComment([finding], META);
    expect(withFlag).toBe(withoutFlag);
  });

  it("flag OFF with findingIds supplied: still byte-identical (ids ignored)", () => {
    const finding = mkFinding();
    const withIds = formatPRComment([finding], {
      ...META,
      precisionFeedbackEnabled: false,
      findingIds: [FINDING_ID_0],
    });
    const baseline = formatPRComment([finding], META);
    expect(withIds).toBe(baseline);
  });

  it("flag ON: includes dismiss footer line", () => {
    const out = formatPRComment([mkFinding()], {
      ...META,
      precisionFeedbackEnabled: true,
      findingIds: [FINDING_ID_0],
    });
    expect(out).toContain("@antfleet dismiss");
    expect(out).toContain("retract it");
  });

  it("flag ON with findingIds: displays the canonical finding id near the header", () => {
    const out = formatPRComment([mkFinding()], {
      ...META,
      precisionFeedbackEnabled: true,
      findingIds: [FINDING_ID_0],
    });
    expect(out).toContain(`\`${FINDING_ID_0}\``);
    expect(out).toContain("<sub>id:");
  });

  it("flag ON with multiple findings: each finding gets its own id", () => {
    const out = formatPRComment([mkFinding(), mkFinding()], {
      ...META,
      precisionFeedbackEnabled: true,
      findingIds: [FINDING_ID_0, FINDING_ID_1],
    });
    expect(out).toContain(`\`${FINDING_ID_0}\``);
    expect(out).toContain(`\`${FINDING_ID_1}\``);
  });

  it("flag ON without findingIds: no id lines, but footer still appears", () => {
    const out = formatPRComment([mkFinding()], {
      ...META,
      precisionFeedbackEnabled: true,
      // findingIds deliberately omitted
    });
    expect(out).toContain("@antfleet dismiss");
    expect(out).not.toContain("<sub>id:");
  });

  it("flag ON: brand copy at top is untouched", () => {
    const out = formatPRComment([mkFinding()], {
      ...META,
      precisionFeedbackEnabled: true,
      findingIds: [FINDING_ID_0],
    });
    expect(out).toContain(
      "Both reviewers flagged the items below on the changed files. AntFleet posts only what two independent frontier models agree on.",
    );
  });

  it("flag ON: dismiss footer is the LAST line of the comment", () => {
    const out = formatPRComment([mkFinding()], {
      ...META,
      precisionFeedbackEnabled: true,
      findingIds: [FINDING_ID_0],
    });
    const lines = out.split("\n");
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toContain("@antfleet dismiss");
    expect(lastLine).toContain("retract it");
  });

  it("flag ON: settlement footer appears before dismiss footer", () => {
    const txHash = "0xabc123";
    const out = formatPRComment([mkFinding()], {
      ...META,
      precisionFeedbackEnabled: true,
      findingIds: [FINDING_ID_0],
      settlement: { channelBalanceUsdc: "2.0", lastDepositTxHash: txHash },
    });
    const settledPos = out.indexOf("Settled");
    const dismissPos = out.indexOf("@antfleet dismiss");
    expect(settledPos).toBeGreaterThan(-1);
    expect(dismissPos).toBeGreaterThan(-1);
    expect(settledPos).toBeLessThan(dismissPos);
  });
});

describe("formatSingleModelSection (Win 2)", () => {
  it("returns null for an empty list (nothing to append)", () => {
    expect(formatSingleModelSection([])).toBeNull();
  });

  it("renders the experimental header, category/severity/title and dismiss id", () => {
    const out = formatSingleModelSection([
      { finding: mkFinding({ severity: "high", title: "Only Anthropic" }), findingId: "rev-1-s0" },
    ]);
    expect(out).not.toBeNull();
    expect(out).toContain("## AntFleet · single-model · experimental");
    expect(out).toContain("**Bug · High** — Only Anthropic");
    // Reuses the consensus finding's `id:` format so the dismiss footer works.
    expect(out).toContain("<sub>id: `rev-1-s0`</sub>");
    expect(out).toContain("`src/foo.ts:10-20`");
  });

  it("orders findings critical → high and joins with the divider", () => {
    const out = formatSingleModelSection([
      { finding: mkFinding({ severity: "high", title: "HI" }), findingId: "r-s0" },
      { finding: mkFinding({ severity: "critical", title: "CR" }), findingId: "r-s1" },
    ]);
    const hiPos = out!.indexOf("HI");
    const crPos = out!.indexOf("CR");
    expect(crPos).toBeGreaterThan(-1);
    expect(crPos).toBeLessThan(hiPos);
    expect(out).toContain("\n\n---\n\n");
  });

  it("is a SEPARATE renderer — formatPRComment output never contains the section", () => {
    // The public comment is byte-identical whether or not a shadow tier exists,
    // because the section is only ever appended by the install lane, never
    // produced inside formatPRComment.
    const publicComment = formatPRComment([mkFinding()], {
      ...META,
      precisionFeedbackEnabled: true,
      findingIds: ["rev-1-0"],
    });
    expect(publicComment).not.toContain("single-model · experimental");
  });
});
