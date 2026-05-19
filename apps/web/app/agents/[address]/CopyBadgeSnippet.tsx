"use client";

import { useState } from "react";

export function CopyBadgeSnippet({ snippet }: { snippet: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="mt-6 flex flex-col gap-3 rounded-md border border-[var(--color-line)] bg-[var(--color-bg-elevated)] p-4">
      <code className="break-all font-mono text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
        {snippet}
      </code>
      <button
        type="button"
        onClick={copy}
        className="w-fit rounded-md border border-[var(--color-line-strong)] px-3 py-1.5 font-mono text-[11px] text-[var(--color-ink)] hover:bg-white"
      >
        {copied ? "copied" : "copy embed"}
      </button>
    </div>
  );
}
