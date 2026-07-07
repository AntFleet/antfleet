import { getInstallationOctokit } from "./github-app";
import { extractNewSideLines } from "./patch-acceptance";
import type { Finding } from "./review-types";
import { shortenReviewId, shortenSha } from "./short-id";

// Order matches AGENTS.md §15 framing — direct, technical. Highest-priority
// items first so reviewers see them before scrolling.
const SEVERITY_ORDER: readonly Finding["severity"][] = ["critical", "high", "medium", "low"];

const REASONING_MAX_CHARS = 500;
const RECOMMENDATION_MAX_CHARS = 300;

// Patch Agent v1.5 — per-finding patch decision the renderer can embed.
// Patch is the unified-diff text the gate selected; modelId names the
// provider whose patch shipped (always claude-opus-4-7 in v1). When null
// (or absent from the patches map), formatFinding emits no suggestion block.
export type PatchForRender = {
  patch: string;
  modelId: string;
  // inline = GitHub suggestion replacement text; artifact = non-click-to-
  // apply unified diff for fixes outside the PR hunk. Undefined preserves
  // pre-v1.7 callers as inline.
  mode?: "inline" | "artifact";
  // Daybreak — patch verifier verdict tag. Set to "verified" when the
  // verifier observed tests passing and (where available) the PoC no
  // longer reproducing. Set to "inconclusive" when verification ran but
  // could not decide. Undefined when the verifier is off (env flag
  // disabled) — renderer treats undefined as "no claim made".
  verifyStatus?: "verified" | "inconclusive";
  // Reason the verifier returned `inconclusive`. Only set when
  // `verifyStatus === "inconclusive"`. The renderer uses this to scope
  // the user-visible tag — "(unverified)" is reserved for genuine
  // could-not-decide outcomes (test_timeout, poc_timeout, exception);
  // softer outcomes (no test runner, no PoC available) render WITHOUT
  // an alarming tag so legitimate patches don't get penalised by
  // missing test infra.
  verifyInconclusiveReason?: string | null;
};

export type ReviewMeta = {
  reviewId: string;
  totalMs: number;
  estimatedCostUsd: number;
  modelIds: Record<string, string>;
  // Paywall settlement footer. Present when the review was paid for via
  // an agent paywall channel; absent for legacy_partner reviews and for
  // pre-paywall reviews. lastDepositTxHash links to basescan as proof of
  // funding; channelBalanceUsdc is the post-debit balance.
  settlement?: {
    channelBalanceUsdc: string;
    lastDepositTxHash: string | null;
  };
  // Patch Agent v1.5 — optional per-finding patches. Keyed by the finding's
  // position in the agreed[] array as passed to formatPRComment (NOT the
  // post-sort severity order, since this layer never sees DB findingIds).
  // Missing key = no patch for that finding; emit findings-only for it.
  // Absent entirely = no patches in this review (flag off, or all findings
  // failed the gate). The comment body shape is byte-identical to v1.4
  // in that case.
  patchesByIndex?: ReadonlyMap<number, PatchForRender>;
  // Patch Agent v1.6 — when true AND a per-finding patch exists AND the
  // finding has single-line evidence, the issue-comment <details>
  // suggestion subsection is replaced by a one-liner pointer to the
  // line-anchored PR review comment (where the "Commit suggestion"
  // button actually renders). Default false → v1.5 behavior preserved
  // byte-identically. Operator decision Q1 LOCKED to REMOVE the inline
  // <details> when click-apply is on (no duplicate suggestion render).
  clickApplyEnabled?: boolean;
  // Step 0.5 — precision feedback affordance. Default false → comment is
  // byte-identical to pre-Step-0.5 output. When true:
  //   • Each finding header gains a <sub> line showing its canonical id.
  //   • A single dismiss instruction footer line is appended.
  // findingIds[i] must be the canonical finding_status.finding_id for the
  // finding at position i in the `findings` array passed to formatPRComment
  // (i.e. indexed to match the input, not the post-sort order). Callers
  // MUST supply findingIds when precisionFeedbackEnabled is true; if the
  // array is absent or shorter than findings, the id is silently omitted
  // for that finding — the flag-off path is always preserved.
  precisionFeedbackEnabled?: boolean;
  findingIds?: readonly string[];
};

export function formatPRComment(findings: Finding[], meta: ReviewMeta): string {
  if (findings.length === 0) return "";
  // Stash the input index alongside each finding so the post-sort body
  // can look up the right patch (patchesByIndex is keyed by the pre-sort
  // index — that's the DB findingIndex the worker writes).
  const indexed = findings.map((f, originalIndex) => ({ f, originalIndex }));
  const sorted = indexed.toSorted((a, b) => severityRank(a.f) - severityRank(b.f));
  const intro =
    `## AntFleet · ${findings.length} finding${findings.length === 1 ? "" : "s"}\n\n` +
    "Both reviewers flagged the items below on the changed files. AntFleet posts only what two independent frontier models agree on.";
  const clickApplyEnabled = meta.clickApplyEnabled === true;
  const precisionFeedbackEnabled = meta.precisionFeedbackEnabled === true;
  const body = sorted
    .map(({ f, originalIndex }) =>
      formatFinding(
        f,
        meta.patchesByIndex?.get(originalIndex) ?? null,
        clickApplyEnabled,
        precisionFeedbackEnabled ? (meta.findingIds?.[originalIndex] ?? null) : null,
      ),
    )
    .join("\n\n---\n\n");
  const stack = Object.values(meta.modelIds)
    .map((m) => `\`${m}\``)
    .join(" + ");
  const footerLines: string[] = [
    `<sub>Review \`${shortenReviewId(meta.reviewId)}\` · ${stack} (unanimous) ` +
      `· ${Math.round(meta.totalMs / 1000)}s · ~$${meta.estimatedCostUsd.toFixed(2)}</sub>`,
  ];
  if (meta.settlement !== undefined) {
    const patchIncluded = meta.patchesByIndex !== undefined && meta.patchesByIndex.size > 0;
    footerLines.push(formatSettlementFooter(meta.settlement, patchIncluded));
  }
  if (precisionFeedbackEnabled) {
    footerLines.push(
      "<sub>Wrong call? Reply `@antfleet dismiss <finding-id> [reason]` on this PR and we'll retract it.</sub>",
    );
  }
  return `${intro}\n\n---\n\n${body}\n\n—\n\n${footerLines.join("\n")}`;
}

function formatSettlementFooter(
  s: NonNullable<ReviewMeta["settlement"]>,
  patchIncluded: boolean,
): string {
  const balance = `${s.channelBalanceUsdc} USDC`;
  // Patch Agent v1.5: spec §4 — append "Patch settled" verb only when at
  // least one suggestion block was shipped in this comment. Pre-v1.5
  // comments (and findings-only v1.5 comments) keep the existing
  // "Settled · ..." text byte-identical.
  const verb = patchIncluded ? "Patch settled" : "Settled";
  if (s.lastDepositTxHash === null) {
    return `<sub>${verb} · channel balance ${balance}</sub>`;
  }
  const shortHash = `${s.lastDepositTxHash.slice(0, 6)}…${s.lastDepositTxHash.slice(-4)}`;
  const basescan = `https://basescan.org/tx/${s.lastDepositTxHash}`;
  return `<sub>${verb} · tx [\`${shortHash}\`](${basescan}) · channel balance ${balance}</sub>`;
}

function formatFinding(
  f: Finding,
  patch: PatchForRender | null,
  clickApplyEnabled: boolean,
  findingId: string | null = null,
): string {
  const ev = f.evidence[0];
  const lines: string[] = [];
  lines.push(`**${titleCase(f.category)} · ${titleCase(f.severity)}** — ${f.title}`);
  if (findingId !== null) {
    lines.push(`<sub>id: \`${findingId}\`</sub>`);
  }
  if (ev !== undefined) {
    lines.push(`\`${formatEvidencePath(ev)}\``);
  }
  lines.push("");
  lines.push(`> ${truncate(f.reasoning, REASONING_MAX_CHARS)}`);
  lines.push("");
  lines.push(`**Fix:** ${formatRecommendation(f)}`);
  // Patch Agent v1.5: optional suggestion subsection AFTER the fix line,
  // delimited as <details> so the finding metadata stays scannable and the
  // sweeper's regex on the header line is unaffected. Spec §4 names the
  // exact shape.
  //
  // GitHub's ```suggestion``` block expects the LITERAL replacement text
  // (what the file should look like after the fix), not unified-diff
  // syntax. We extract the new-side lines from the unified diff the model
  // emitted before rendering. If the diff is pure-deletion (no new-side
  // lines), we render no suggestion block — there's nothing to commit.
  //
  // Backtick safety: a diff body containing ``` would close the markdown
  // fence early and corrupt the comment. We escape by switching to a
  // ~~~ fence when the replacement text contains triple-backticks.
  //
  // Patch Agent v1.6 — when clickApplyEnabled AND the finding has single-line
  // evidence, replace the inline <details> block with a one-line pointer
  // to the line-anchored PR review comment (operator decision Q1 LOCKED).
  // Multi-line evidence still gets the v1.5 <details> path because review
  // comments only render the apply button on a single anchored line and
  // start_line ranges detach across edits (operator decision Q2 LOCKED).
  if (patch !== null) {
    const mode = patch.mode ?? "inline";
    const block =
      mode === "artifact" ? renderDiffArtifactBlock(patch) : renderSuggestionBlock(patch);
    if (block !== null) {
      const evidenceIsSingleLine =
        ev !== undefined &&
        ev.startLine !== null &&
        (ev.endLine === null || ev.endLine === ev.startLine);
      // Only tag "(unverified)" for inconclusive verdicts that signal
      // genuine indecision. Soft outcomes — no test runner detected, no PoC
      // available — leave the suggestion untagged so legit patches aren't
      // penalised by missing test infra. The reason set comes from the
      // verifier's InconclusiveReason enum (see patch-verifier.ts).
      const SOFT_INCONCLUSIVE = new Set(["no_runner", "no_poc", "no_repo_url"]);
      const verifyTag =
        patch.verifyStatus === "inconclusive" &&
        !SOFT_INCONCLUSIVE.has(patch.verifyInconclusiveReason ?? "")
          ? " (unverified)"
          : "";
      if (mode === "artifact") {
        lines.push("");
        lines.push(`<details>`);
        lines.push(
          `<summary>Out-of-hunk patch artifact (model: ${patch.modelId}${verifyTag})</summary>`,
        );
        lines.push("");
        lines.push(
          `This non-click-to-apply fix is outside the PR diff hunk, so GitHub cannot render it as a suggestion.`,
        );
        lines.push("");
        lines.push(...block);
        lines.push(`</details>`);
      } else if (clickApplyEnabled && evidenceIsSingleLine) {
        lines.push("");
        lines.push(
          `→ Proposed patch${verifyTag} as a reviewable comment below (click \`Commit suggestion\`)`,
        );
      } else {
        lines.push("");
        lines.push(`<details>`);
        lines.push(`<summary>Proposed patch (model: ${patch.modelId}${verifyTag})</summary>`);
        lines.push("");
        lines.push(...block);
        lines.push(`</details>`);
      }
    }
  }
  return lines.join("\n");
}

export function renderSuggestionBlock(patch: PatchForRender): string[] | null {
  const newLines = extractNewSideLines(patch.patch);
  if (newLines.length === 0) return null;
  const replacement = newLines.join("\n");
  // Switch to ~~~ when the replacement contains the default ``` fence
  // so the markdown stays well-formed regardless of patch content.
  if (replacement.includes("```")) {
    return [`~~~suggestion`, replacement, `~~~`];
  }
  return ["```suggestion", replacement, "```"];
}

export function renderDiffArtifactBlock(patch: PatchForRender): string[] | null {
  if (patch.patch.trim().length === 0) return null;
  if (patch.patch.includes("```")) {
    return ["~~~diff", patch.patch.trimEnd(), "~~~"];
  }
  return ["```diff", patch.patch.trimEnd(), "```"];
}

function formatEvidencePath(ev: Finding["evidence"][number]): string {
  if (ev.startLine === null) return ev.path;
  if (ev.endLine === null || ev.endLine === ev.startLine) {
    return `${ev.path}:${ev.startLine}`;
  }
  return `${ev.path}:${ev.startLine}-${ev.endLine}`;
}

function severityRank(f: Finding): number {
  const idx = SEVERITY_ORDER.indexOf(f.severity);
  return idx === -1 ? SEVERITY_ORDER.length : idx;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1).trimEnd()}…`;
}

function formatRecommendation(f: Finding): string {
  const prefix = labelPrefix(f.label);
  return `${prefix}${truncate(f.recommendation, RECOMMENDATION_MAX_CHARS)}`;
}

function labelPrefix(label: Finding["label"] | undefined): string {
  switch (label) {
    case "nit":
      return "**Nit:** ";
    case "optional":
      return "**Optional:** ";
    case "fyi":
      return "**FYI:** ";
    default:
      return "";
  }
}

/**
 * Closure receipt formatter — Mission 3 slice 3. When Sweeper detects a
 * finding's evidence file has changed on main, it posts a follow-up
 * comment on the original PR that names the closing SHA. This is the
 * receipt artifact referenced in AGENTS.md §18.2 — public, verifiable,
 * the thing customers cannot fake.
 *
 * Voice matches formatPRComment: direct, technical, no marketing. The
 * closing SHA is the load-bearing element; everything else is context
 * that reminds readers what this finding was.
 */
export type ClosureReceiptInput = {
  findingId: string;
  closureSha: string;
  finding: Finding;
  owner: string;
  repo: string;
  originalCommentUrl: string | null;
};

export function formatClosureReceipt(args: ClosureReceiptInput): string {
  const f = args.finding;
  const shortSha = shortenSha(args.closureSha);
  const closingCommitUrl = `https://github.com/${args.owner}/${args.repo}/commit/${args.closureSha}`;
  const ev = f.evidence[0];

  const lines: string[] = [];
  lines.push(
    `## AntFleet · finding \`${args.findingId}\` closed in [\`${shortSha}\`](${closingCommitUrl})`,
  );
  lines.push("");
  lines.push(`**${titleCase(f.category)} · ${titleCase(f.severity)}** — ${f.title}`);
  if (ev !== undefined) {
    lines.push(`\`${formatEvidencePath(ev)}\``);
  }
  lines.push("");
  if (args.originalCommentUrl !== null && args.originalCommentUrl.length > 0) {
    lines.push(
      `<sub>Originally flagged in [the AntFleet review](${args.originalCommentUrl}). Receipt automated.</sub>`,
    );
  } else {
    lines.push("<sub>Receipt automated by AntFleet.</sub>");
  }
  return lines.join("\n");
}

/**
 * Patch Agent v1.5 — patch-acceptance receipt. Posted by the sweeper when
 * a finding's suggested patch is detected in HEAD on the default branch.
 * Distinct from formatClosureReceipt: that one says "the file was touched",
 * this one says "the maintainer adopted what we proposed". Both can fire
 * on the same finding (the suggestion was followed AND any other change
 * also touched the file) — the receipts pin the difference.
 */
export type PatchAcceptanceReceiptInput = {
  findingId: string;
  acceptedSha: string;
  patchModelId: string | null;
  owner: string;
  repo: string;
  originalCommentUrl: string | null;
};

export function formatPatchAcceptanceReceipt(args: PatchAcceptanceReceiptInput): string {
  const shortSha = shortenSha(args.acceptedSha);
  const commitUrl = `https://github.com/${args.owner}/${args.repo}/commit/${args.acceptedSha}`;
  const modelLabel = args.patchModelId === null ? "" : ` (model: \`${args.patchModelId}\`)`;
  const lines: string[] = [];
  lines.push(
    `## AntFleet · suggested patch for \`${args.findingId}\` accepted in [\`${shortSha}\`](${commitUrl})${modelLabel}`,
  );
  lines.push("");
  if (args.originalCommentUrl !== null && args.originalCommentUrl.length > 0) {
    lines.push(
      `<sub>Originally proposed in [the AntFleet review](${args.originalCommentUrl}). Receipt automated.</sub>`,
    );
  } else {
    lines.push("<sub>Receipt automated by AntFleet.</sub>");
  }
  return lines.join("\n");
}

export async function postPRComment(args: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
}): Promise<{ id: number; htmlUrl: string }> {
  const octokit = await getInstallationOctokit(args.installationId);
  const resp = await octokit.rest.issues.createComment({
    owner: args.owner,
    repo: args.repo,
    issue_number: args.prNumber,
    body: args.body,
  });
  return { id: resp.data.id, htmlUrl: resp.data.html_url };
}
