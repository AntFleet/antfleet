import type { ReactNode } from "react";

export interface TweetIntentProps {
  text: string;
  url: string;
  via?: string;
  className?: string;
  children?: ReactNode;
  ariaLabel?: string;
}

// Server-rendered <a> linking to x.com/intent/tweet. No client JS, no
// state — Next.js renders the final href server-side, then the user's
// browser opens X with the text + url already populated. Used by
// /receipts, /agents/[address], /roasts/[id] (ShareSection), and
// /digest/[date] (the weekly permalink) to make every public artifact
// one-click tweetable without an autoposter pipeline.
export function TweetIntent({
  text,
  url,
  via = "AntFleetDev",
  className,
  children,
  ariaLabel,
}: TweetIntentProps) {
  const params = new URLSearchParams({ text, url, via });
  const href = `https://x.com/intent/tweet?${params.toString()}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      aria-label={ariaLabel}
    >
      {children ?? "Tweet ↗"}
    </a>
  );
}
