"use client";

import { useState, useCallback } from "react";
import type { AnatomyBundle } from "@/lib/anatomy";
import { redactSecrets } from "@/lib/disagreements";

export interface ThreadTemplateProps {
  bundle: AnatomyBundle;
  pageUrl: string;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "\u2026";
}

import { shortenRepoHash } from "@/lib/short-id";

function buildThread(bundle: AnatomyBundle, pageUrl: string): string[] {
  const repoShort = shortenRepoHash(bundle.repoHash);
  const shaShort = bundle.closureSha?.slice(0, 7) ?? "pending";

  const tweet1 = truncate(
    `Two frontier models reviewed PR #${bundle.prNumber} on ${repoShort}.\nBoth found this bug:\n\n${bundle.severity} ${bundle.category}: ${bundle.title}`,
    280,
  );

  const tweet2 = truncate(
    `The vulnerable code (${bundle.source.file}:${bundle.source.lineStart}-${bundle.source.lineEnd}):\n\n(full snippet at ${pageUrl})`,
    280,
  );

  const opusReasoning = bundle.reasoning.anthropic?.reasoning ?? "Output unavailable";
  const tweet3 = truncate(`What Opus saw:\n\n"${redactSecrets(opusReasoning)}"`, 280);

  const gptReasoning = bundle.reasoning.openai?.reasoning ?? "Output unavailable";
  const tweet4 = truncate(`What GPT-5 saw:\n\n"${redactSecrets(gptReasoning)}"`, 280);

  const tweet5 =
    "Both flagged the same line range. AntFleet's unanimous gate fired \u2014 the finding posted on the PR.";

  const tweet6 = truncate(
    `The fix landed in commit ${shaShort}:\n\n(view diff at ${pageUrl})`,
    280,
  );

  const tweet7 =
    "AntFleet reviews every PR with two frontier models. Only unanimous findings post.";

  const tweet8 = truncate(`Full anatomy + reasoning + diffs:\n${pageUrl}`, 280);

  return [tweet1, tweet2, tweet3, tweet4, tweet5, tweet6, tweet7, tweet8];
}

export function ThreadTemplate({ bundle, pageUrl }: ThreadTemplateProps) {
  const [copied, setCopied] = useState(false);
  const tweets = buildThread(bundle, pageUrl);

  const handleCopy = useCallback(() => {
    const full = tweets
      .map((t, i) => `--- tweet ${i + 1} of ${tweets.length} ---\n${t}`)
      .join("\n\n");
    navigator.clipboard
      .writeText(full)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }, [tweets]);

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
          Tweet thread template
        </h2>
        <button
          onClick={handleCopy}
          className="rounded border border-[var(--color-line-strong)] px-3 py-1 font-mono text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] hover:border-[var(--color-ink-subtle)] transition-colors"
        >
          {copied ? "Copied!" : "Copy thread"}
        </button>
      </div>

      <div className="flex flex-col gap-3">
        {tweets.map((tweet, i) => (
          <div
            key={i}
            className="rounded-md border border-[var(--color-line)] bg-[var(--color-bg-elevated)] p-4"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
                tweet {i + 1} of {tweets.length}
              </span>
              <span
                className={`font-mono text-[11px] ${tweet.length > 280 ? "text-red-400" : "text-[var(--color-ink-subtle)]"}`}
              >
                {tweet.length} / 280
              </span>
            </div>
            <p className="whitespace-pre-wrap font-mono text-xs text-[var(--color-ink-muted)] leading-relaxed">
              {tweet}
            </p>
          </div>
        ))}
      </div>

      <p className="mt-4 font-mono text-[11px] text-[var(--color-ink-subtle)]">
        Paste into X composer one tweet at a time. X has no multi-tweet intent API.
      </p>
    </div>
  );
}
