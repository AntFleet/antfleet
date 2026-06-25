// Public agent-page "Cyber" pill. Surfaces only that ONE of the agent's
// covered repos has been operator-classified as cyber tier — does NOT
// identify which one. The per-repo existence of a cyber finding stays
// hidden via the existing /activity / scorecard / sitemap exclusions.
//
// Rendered only when AgentDetail.hasCyberTierRepo is true, which itself
// is only true when ANTFLEET_CYBER_TIER is on. When the flag is off the
// loader returns false regardless of repo_tier rows so the badge cannot
// appear — byte-identical behavior to pre-cyber-tier.

export function CyberTierBadge() {
  return (
    <span
      title="stricter posture: private-by-default disclosure for sensitive repos"
      className="inline-flex items-center rounded-full border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] px-2 py-0.5 font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-muted)]"
    >
      Cyber
    </span>
  );
}
