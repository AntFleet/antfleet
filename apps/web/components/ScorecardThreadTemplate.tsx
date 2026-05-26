"use client";

import { useState } from "react";
import type { ScorecardPayload } from "@/lib/scorecard";

export function ScorecardThreadTemplate({
  payload,
  pageUrl,
}: {
  payload: ScorecardPayload;
  pageUrl: string;
}) {
  const [copied, setCopied] = useState(false);
  const thread = buildThread(payload, pageUrl);

  function handleCopy() {
    navigator.clipboard.writeText(thread).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="font-mono text-xs text-[var(--color-ink-subtle)] tracking-widest uppercase">
          Thread template (5 tweets)
        </p>
        <button
          onClick={handleCopy}
          className="font-mono text-xs px-3 py-1.5 rounded border border-[var(--color-line)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] hover:bg-[var(--color-bg-elevated)] transition-colors"
        >
          {copied ? "Copied" : "Copy thread"}
        </button>
      </div>
      <pre className="text-sm font-mono text-[var(--color-ink-muted)] whitespace-pre-wrap leading-relaxed bg-[var(--color-bg-elevated)] border border-[var(--color-line)] rounded-lg p-4 overflow-x-auto">
        {thread}
      </pre>
      <p className="mt-3 text-xs text-[var(--color-ink-subtle)]">
        Paste into X composer one tweet at a time.
      </p>
    </div>
  );
}

function buildThread(p: ScorecardPayload, pageUrl: string): string {
  const opusFPR = p.perProvider.anthropic.avgFindingsPerPR.toFixed(1);
  const gpt5FPR = p.perProvider.openai.avgFindingsPerPR.toFixed(1);
  const anthropicMedian = p.perProvider.anthropic.medianWallTimeSeconds.toFixed(0);
  const openaiMedian = p.perProvider.openai.medianWallTimeSeconds.toFixed(0);

  const aTopCats = p.perProvider.anthropic.topCategories.map((c) => c.category);
  const oTopCats = p.perProvider.openai.topCategories.map((c) => c.category);

  const rollingPct =
    p.rolling4Week.bothProposedRate !== null
      ? (p.rolling4Week.bothProposedRate * 100).toFixed(0)
      : "N/A";

  const tweets = [
    // Tweet 1
    `AntFleet scorecard, week of ${p.weekEnd}:
${p.sample.reviewsAnalyzed} reviews · ${p.sample.findingsPosted} findings posted (unanimous gate)
Opus: ${opusFPR} findings/PR · GPT-5: ${gpt5FPR}/PR
Wall time: Anthropic ${anthropicMedian}s · OpenAI ${openaiMedian}s`,

    // Tweet 2
    `Patch agreement: ${p.agreement.bothProposedPatches}/${p.sample.findingsPosted} reviews had both models propose a patch.
${p.agreement.gpt5OnlyFindings} GPT-5 solo patch proposals this week.
Disagreement archive: antfleet.dev/disagreements`,

    // Tweet 3
    `Top finding categories:
Anthropic: ${aTopCats.join(", ") || "none this week"}
OpenAI: ${oTopCats.join(", ") || "none this week"}`,

    // Tweet 4
    `4-week rolling agreement rate: ${rollingPct}%

Full table + methodology: ${pageUrl}`,

    // Tweet 5
    `Real-world data, not a static benchmark — every review ran on opted-in customer code that didn't exist when these models were trained.

Scorecard archive: antfleet.dev/scorecard`,
  ];

  return tweets
    .map((t, i) => `--- tweet ${i + 1} of 5 ---\n${t}`)
    .join("\n\n");
}
