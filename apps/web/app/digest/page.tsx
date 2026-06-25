import type { Metadata } from "next";
import { sql } from "drizzle-orm";
import { db } from "@/db/index";
import { weeklyFeatures } from "@/db/schema";
import { agentFindings } from "@/db/schema";
import { severityLabel } from "@/lib/agent-findings";
import { rawCyberTierExclusionForFullName } from "@/lib/cyber-tier";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AntFleet · Weekly Digest",
  description:
    "Week-by-week summary of AntFleet's code review activity, top closures, and fleet stats.",
};

type DigestWeekRow = {
  weekStart: string;
  findingId: string;
  agentName: string;
  title: string;
  severity: string;
  curatedBy: string;
};

async function loadAllDigestWeeks(): Promise<DigestWeekRow[]> {
  // Cyber-tier exclusion: the weekly digest page renders finding titles
  // + severity for every featured finding. Without filtering, a cyber-
  // classified repo's finding could leak via the digest if it was
  // curated before the repo flipped to cyber, OR via concurrent curator
  // runs. The drift detector in lib/cyber-tier-visibility.contract.test.ts
  // caught this surface in pass-3.
  const cyberExclude = rawCyberTierExclusionForFullName(sql`${agentFindings.repoFullName}`);
  const result = await db.execute(sql`
    SELECT
      wf.week_start AS "weekStart",
      wf.finding_id AS "findingId",
      wf.curated_by AS "curatedBy",
      ${agentFindings.agentName} AS "agentName",
      ${agentFindings.title} AS "title",
      ${agentFindings.severity} AS "severity"
    FROM ${weeklyFeatures} wf
    JOIN ${agentFindings} ON ${agentFindings.findingId} = wf.finding_id
    WHERE true ${cyberExclude}
    ORDER BY wf.week_start DESC
  `);
  const rows = Array.isArray(result)
    ? (result as unknown as DigestWeekRow[])
    : ((result as unknown as { rows?: DigestWeekRow[] }).rows ?? []);
  return rows;
}

export default async function DigestListingPage() {
  const weeks = await loadAllDigestWeeks();

  return (
    <>
      <section className="py-20 pb-12">
        <ContentWrap>
          <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
            Weekly summary · updated every Monday
          </p>

          <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug max-w-xl">
            Weekly digest
          </h1>

          <p className="mt-6 text-sm text-[var(--color-ink-muted)] max-w-xl leading-relaxed">
            Each digest covers one week of AntFleet activity — reviews run, findings agreed,
            receipts closed, and the top closures by severity. Click any week to see the full
            breakdown.
          </p>
        </ContentWrap>
      </section>

      <SectionDivider />

      {weeks.length === 0 ? <EmptyState /> : <WeeksList weeks={weeks} />}
    </>
  );
}

function WeeksList({ weeks }: { weeks: DigestWeekRow[] }) {
  return (
    <section className="pb-20">
      <ContentWrap>
        <div className="mb-6 flex items-baseline justify-between">
          <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
            All weeks
          </h2>
          <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
            {weeks.length} {weeks.length === 1 ? "digest" : "digests"}
          </span>
        </div>

        <ul className="flex flex-col divide-y divide-[var(--color-line)] border-t border-b border-[var(--color-line)]">
          {weeks.map((week) => (
            <li key={week.weekStart}>
              <WeekRow week={week} />
            </li>
          ))}
        </ul>
      </ContentWrap>
    </section>
  );
}

function WeekRow({ week }: { week: DigestWeekRow }) {
  const weekStartDate = new Date(`${week.weekStart}T00:00:00.000Z`);
  const label = weekStartDate.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <a
      href={`/digest/${week.weekStart}`}
      className="group -mx-3 flex flex-col gap-3 rounded-md px-3 py-5 transition-colors hover:bg-[var(--color-bg-elevated)] sm:flex-row sm:items-start sm:gap-6"
    >
      <div className="flex flex-wrap items-center gap-2 sm:w-36 sm:shrink-0">
        <span className="font-mono text-xs text-[var(--color-ink)]">Week of {label}</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm leading-snug text-[var(--color-ink)] underline-offset-2 group-hover:underline">
          {week.title}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
          <span>{week.agentName}</span>
          <span className="text-[var(--color-line-strong)]">·</span>
          <span>{severityLabel(week.severity)}</span>
        </div>
      </div>
      <span className="font-mono text-[11px] text-[var(--color-ink-subtle)] transition-colors group-hover:text-[var(--color-ink)] sm:shrink-0 sm:self-center">
        view digest →
      </span>
    </a>
  );
}

function EmptyState() {
  return (
    <section className="pb-20">
      <ContentWrap>
        <div className="rounded-md border border-dashed border-[var(--color-line-strong)] p-8 text-center">
          <p className="text-sm text-[var(--color-ink)] mb-2">No digests yet.</p>
          <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed max-w-md mx-auto">
            The weekly curator runs each Monday. The first digest will appear after a full week of
            review activity.
          </p>
        </div>
      </ContentWrap>
    </section>
  );
}

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="border-t border-[var(--color-line)] my-16" />;
}
