import type { ProviderStats } from "@/lib/scorecard";

export function ScorecardTable({
  anthropic,
  openai,
  label,
}: {
  anthropic: ProviderStats;
  openai: ProviderStats;
  label?: string;
}) {
  return (
    <div className="overflow-x-auto">
      {label && (
        <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-4 tracking-widest uppercase">
          {label}
        </p>
      )}
      <table className="w-full text-sm font-mono">
        <thead>
          <tr className="border-b border-[var(--color-line)]">
            <th className="text-left py-2 pr-6 text-[var(--color-ink-subtle)] font-normal text-xs tracking-widest uppercase">
              Metric
            </th>
            <th className="text-right py-2 px-4 text-[var(--color-ink-subtle)] font-normal text-xs tracking-widest uppercase">
              Anthropic
            </th>
            <th className="text-right py-2 pl-4 text-[var(--color-ink-subtle)] font-normal text-xs tracking-widest uppercase">
              OpenAI
            </th>
          </tr>
        </thead>
        <tbody>
          <Row
            label="Avg findings / PR"
            a={fmt(anthropic.avgFindingsPerPR)}
            b={fmt(openai.avgFindingsPerPR)}
            highlight={diverges(anthropic.avgFindingsPerPR, openai.avgFindingsPerPR)}
          />
          <Row
            label="Median wall time"
            a={`${fmt(anthropic.medianWallTimeSeconds)}s`}
            b={`${fmt(openai.medianWallTimeSeconds)}s`}
            highlight={diverges(anthropic.medianWallTimeSeconds, openai.medianWallTimeSeconds)}
          />
          <Row
            label="Avg cost / review"
            a={anthropic.avgCostUsd !== null ? `$${fmt(anthropic.avgCostUsd)}` : "\u2014"}
            b={openai.avgCostUsd !== null ? `$${fmt(openai.avgCostUsd)}` : "\u2014"}
          />
          <Row
            label="Patch proposal rate"
            a={pct(anthropic.patchProposalRate)}
            b={pct(openai.patchProposalRate)}
            highlight={diverges(anthropic.patchProposalRate, openai.patchProposalRate)}
          />
        </tbody>
      </table>
    </div>
  );
}

function Row({
  label,
  a,
  b,
  highlight = false,
}: {
  label: string;
  a: string;
  b: string;
  highlight?: boolean;
}) {
  const rowClass = highlight
    ? "border-b border-[var(--color-line)] bg-[var(--color-bg-elevated)]"
    : "border-b border-[var(--color-line)]";
  return (
    <tr className={rowClass}>
      <td className="py-2.5 pr-6 text-[var(--color-ink-muted)]">{label}</td>
      <td className="py-2.5 px-4 text-right text-[var(--color-ink)]">{a}</td>
      <td className="py-2.5 pl-4 text-right text-[var(--color-ink)]">{b}</td>
    </tr>
  );
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function diverges(a: number, b: number): boolean {
  if (a === 0 && b === 0) return false;
  const avg = (a + b) / 2;
  if (avg === 0) return false;
  return Math.abs(a - b) / avg > 0.1;
}
