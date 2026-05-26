import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadScorecardSnapshot } from "@/db/queries";
import { parseWeekEndingDate } from "@/lib/scorecard";
import { ScorecardTable } from "@/components/ScorecardTable";

export const dynamic = "force-dynamic";

type RouteParams = { "yyyy-mm-dd": string };

export async function generateMetadata({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { "yyyy-mm-dd": date } = await params;
  if (parseWeekEndingDate(date) === null) {
    return { title: "AntFleet · Scorecard" };
  }
  return {
    title: `AntFleet · Scorecard ${date}`,
    description: `Weekly provider comparison for the week ending ${date}.`,
  };
}

export default async function ScorecardWeekPage({
  params,
}: {
  params: Promise<RouteParams>;
}) {
  const { "yyyy-mm-dd": dateStr } = await params;
  if (parseWeekEndingDate(dateStr) === null) notFound();

  const snapshot = await loadScorecardSnapshot(dateStr);
  if (snapshot === null) notFound();

  const p = snapshot.payload;

  // Compute prev/next week dates for navigation
  const weekEndDate = new Date(dateStr + "T00:00:00Z");
  const prevSunday = new Date(weekEndDate);
  prevSunday.setUTCDate(prevSunday.getUTCDate() - 7);
  const nextSunday = new Date(weekEndDate);
  nextSunday.setUTCDate(nextSunday.getUTCDate() + 7);
  const prevDate = prevSunday.toISOString().slice(0, 10);
  const nextDate = nextSunday.toISOString().slice(0, 10);

  // Check if prev/next snapshots exist (cheap DB lookups)
  const [prevSnapshot, nextSnapshot] = await Promise.all([
    loadScorecardSnapshot(prevDate),
    loadScorecardSnapshot(nextDate),
  ]);

  return (
    <>
      {/* Hero */}
      <section className="py-20 pb-12">
        <ContentWrap>
          <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
            AI Scorecard
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug">
            Week of {p.weekEnd}
          </h1>
          <p className="mt-4 text-sm text-[var(--color-ink-muted)]">
            {p.sample.reviewsAnalyzed} reviews analyzed &middot;{" "}
            {p.sample.findingsPosted} findings posted
          </p>
          <p className="mt-2 text-xs font-mono text-[var(--color-ink-subtle)]">
            {p.weekStart} &rarr; {p.weekEnd} &middot; public-receipt reviews only
          </p>
        </ContentWrap>
      </section>

      <SectionDivider />

      {/* This week */}
      <Section title="This week">
        <ScorecardTable anthropic={p.perProvider.anthropic} openai={p.perProvider.openai} />
      </Section>

      <SectionDivider />

      {/* Rolling 4-week */}
      <Section title="4-week rolling average">
        {p.rolling4Week.avgFindingsPerPRAnthropic !== null ? (
          <ScorecardTable
            anthropic={{
              avgFindingsPerPR: p.rolling4Week.avgFindingsPerPRAnthropic ?? 0,
              medianWallTimeSeconds: p.rolling4Week.medianWallTimeAnthropic ?? 0,
              avgCostUsd: null,
              patchProposalRate: p.rolling4Week.bothProposedRate ?? 0,
              topCategories: [],
            }}
            openai={{
              avgFindingsPerPR: p.rolling4Week.avgFindingsPerPROpenai ?? 0,
              medianWallTimeSeconds: p.rolling4Week.medianWallTimeOpenai ?? 0,
              avgCostUsd: null,
              patchProposalRate: p.rolling4Week.bothProposedRate ?? 0,
              topCategories: [],
            }}
          />
        ) : (
          <p className="text-sm text-[var(--color-ink-muted)]">
            Not enough data for a 4-week rolling average yet.
          </p>
        )}
      </Section>

      <SectionDivider />

      {/* Agreement */}
      <Section title="Agreement">
        <div className="flex flex-col gap-3 text-sm font-mono">
          <StatLine label="Agreement rate" value={pct(p.agreement.rate)} />
          <StatLine label="Both proposed patches" value={String(p.agreement.bothProposedPatches)} />
          <StatLine label="Opus-only findings" value={String(p.agreement.opusOnlyFindings)} />
          <StatLine label="GPT-5-only findings" value={String(p.agreement.gpt5OnlyFindings)} />
        </div>
      </Section>

      <SectionDivider />

      {/* Top categories */}
      <Section title="Top categories">
        <div className="grid grid-cols-2 gap-8">
          <div>
            <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-3 tracking-widest uppercase">
              Anthropic
            </p>
            <CategoryList categories={p.perProvider.anthropic.topCategories} />
          </div>
          <div>
            <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-3 tracking-widest uppercase">
              OpenAI
            </p>
            <CategoryList categories={p.perProvider.openai.topCategories} />
          </div>
        </div>
      </Section>

      <SectionDivider />

      {/* Methodology + reproduce */}
      <Section title="About this data">
        <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed max-w-xl">
          Same code path as{" "}
          <code className="font-mono text-xs text-[var(--color-ink)]">
            /api/v1/installations/&#123;id&#125;/review
          </code>{" "}
          &mdash;{" "}
          <a
            href="https://github.com/AntFleet/antfleet-core"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-ink)] underline underline-offset-2"
          >
            open source
          </a>
          .{" "}
          <a
            href="/about/methodology"
            className="text-[var(--color-ink)] underline underline-offset-2"
          >
            Full methodology
          </a>
          .
        </p>
      </Section>

      <SectionDivider />

      {/* Navigation */}
      <section className="pb-20">
        <ContentWrap>
          <div className="flex items-center justify-between">
            {prevSnapshot !== null ? (
              <a
                href={`/scorecard/${prevDate}`}
                className="font-mono text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline underline-offset-2 transition-colors"
              >
                &larr; {prevDate}
              </a>
            ) : (
              <span />
            )}
            <a
              href="/scorecard"
              className="font-mono text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline underline-offset-2 transition-colors"
            >
              all scorecards
            </a>
            {nextSnapshot !== null ? (
              <a
                href={`/scorecard/${nextDate}`}
                className="font-mono text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline underline-offset-2 transition-colors"
              >
                {nextDate} &rarr;
              </a>
            ) : (
              <span />
            )}
          </div>
        </ContentWrap>
      </section>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="py-12">
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-6">
          {title}
        </h2>
        {children}
      </ContentWrap>
    </section>
  );
}

function StatLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center py-1 border-b border-[var(--color-line)]">
      <span className="text-[var(--color-ink-muted)]">{label}</span>
      <span className="text-[var(--color-ink)]">{value}</span>
    </div>
  );
}

function CategoryList({ categories }: { categories: Array<{ category: string; count: number }> }) {
  if (categories.length === 0) {
    return <p className="text-sm text-[var(--color-ink-muted)]">No findings this week.</p>;
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {categories.map((c) => (
        <li key={c.category} className="text-sm font-mono text-[var(--color-ink-muted)]">
          {c.category}{" "}
          <span className="text-[var(--color-ink-subtle)]">({c.count})</span>
        </li>
      ))}
    </ul>
  );
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="border-t border-[var(--color-line)] mx-auto max-w-3xl" />;
}
