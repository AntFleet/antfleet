import { loadAllTimeActivityWindow } from "@/db/queries";
import { formatHoursToFix, loadPatchKpis } from "@/lib/kpis";
import { loadAllTimeAgreementRate } from "@/lib/scorecard";

// Cross-page header strip rendered above the page hero on /impact, /scorecard,
// /activity. Five linked headline numbers; each label links to the page that
// owns the deeper view. Every loader is React cache()-wrapped so the strip
// shares queries with the page body when they overlap (e.g. /impact's hero
// also calls loadPatchKpis).
export async function StatsStrip() {
  const [kpis, allTime, agreement] = await Promise.all([
    loadPatchKpis(),
    loadAllTimeActivityWindow(),
    loadAllTimeAgreementRate(),
  ]);

  const medianLabel =
    kpis.medianHoursToFix === null ? "—" : formatHoursToFix(kpis.medianHoursToFix);
  const agreementLabel = agreement === null ? "—" : `${Math.round(agreement.rate * 100)}%`;

  return (
    <section
      aria-label="AntFleet headline stats"
      className="border-b border-[var(--color-line)] bg-[var(--color-bg)]"
    >
      <div className="mx-auto max-w-5xl px-6 py-4">
        <ul className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
          <Cell href="/impact" label="patches landed" value={kpis.patchesLanded.toLocaleString()} />
          <Cell href="/impact" label="median time to fix" value={medianLabel} />
          <Cell
            href="/activity"
            label="reviews analyzed"
            value={allTime.reviewsRun.toLocaleString()}
          />
          <Cell
            href="/activity"
            label="findings posted"
            value={allTime.findingsAgreed.toLocaleString()}
          />
          <Cell href="/scorecard" label="model agreement" value={agreementLabel} />
        </ul>
      </div>
    </section>
  );
}

function Cell({ href, label, value }: { href: string; label: string; value: string }) {
  return (
    <li>
      <a
        href={href}
        className="group inline-flex items-baseline gap-2 transition-colors hover:text-[var(--color-ink)]"
      >
        <span className="font-mono text-base font-semibold tabular-nums text-[var(--color-ink)]">
          {value}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] group-hover:text-[var(--color-ink-muted)]">
          {label}
        </span>
      </a>
    </li>
  );
}
