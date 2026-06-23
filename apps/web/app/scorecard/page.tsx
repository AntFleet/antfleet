import type { Metadata } from "next";
import { StatsStrip } from "@/components/StatsStrip";
import { loadScorecardIndex } from "@/db/queries";
import type { ScorecardPayload } from "@/lib/scorecard";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 12;

export const metadata: Metadata = {
  title: "AntFleet · AI Scorecard",
  description:
    "Weekly provider-comparison data from real-world code reviews. Two frontier models, rolling numbers, no static benchmark.",
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ScorecardIndexPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const rawBefore = typeof params["before"] === "string" ? params["before"] : undefined;
  const before = rawBefore && /^\d{4}-\d{2}-\d{2}$/.test(rawBefore) ? rawBefore : undefined;
  const { rows, hasMore } = await loadScorecardIndex({ limit: PAGE_SIZE, before });

  return (
    <>
      <StatsStrip />
      <section className="py-20 pb-12">
        <ContentWrap>
          <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
            AI Scorecard
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug max-w-xl">
            Weekly provider comparison from real-world reviews.
          </h1>
          <p className="mt-8 text-sm text-[var(--color-ink-muted)] max-w-xl leading-relaxed">
            Every week, AntFleet publishes structured comparison data from real-world reviews on
            opted-in customer code. Two frontier models (Claude Opus 4 + GPT-5) run independently;
            only the findings both agree on get posted. The numbers below show what each model
            produces over time. This is rolling data &mdash; not a static benchmark, not a marketing
            exercise.{" "}
            <a
              href="/about/methodology"
              className="text-[var(--color-ink)] underline underline-offset-2"
            >
              Methodology
            </a>
            .
          </p>
        </ContentWrap>
      </section>

      <div className="border-t border-[var(--color-line)]" />

      <section className="py-12">
        <ContentWrap>
          {rows.length === 0 ? (
            <p className="text-sm text-[var(--color-ink-muted)]">
              No scorecards published yet. The first snapshot will appear after the weekly cron
              fires.
            </p>
          ) : (
            <div className="flex flex-col gap-0">
              {rows.map((row) => (
                <ScorecardRow key={row.yyyyMmDd} payload={row.payload} date={row.yyyyMmDd} />
              ))}
            </div>
          )}

          {hasMore && rows.length > 0 && (
            <div className="mt-8">
              <a
                href={`/scorecard?before=${rows[rows.length - 1].yyyyMmDd}`}
                className="font-mono text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline underline-offset-2 transition-colors"
              >
                older scorecards &rarr;
              </a>
            </div>
          )}
        </ContentWrap>
      </section>
    </>
  );
}

function ScorecardRow({ payload, date }: { payload: ScorecardPayload; date: string }) {
  const agreementPct = `${(payload.agreement.rate * 100).toFixed(0)}%`;

  return (
    <a
      href={`/scorecard/${date}`}
      className="flex items-center justify-between gap-4 py-4 border-b border-[var(--color-line)] hover:bg-[var(--color-bg-elevated)] transition-colors px-2 -mx-2 rounded"
    >
      <div>
        <span className="font-mono text-sm text-[var(--color-ink)]">Week of {payload.weekEnd}</span>
      </div>
      <div className="flex items-center gap-6 text-xs font-mono text-[var(--color-ink-muted)]">
        <span>{payload.sample.reviewsAnalyzed} reviews</span>
        <span>{payload.sample.findingsPosted} findings</span>
        <span>agreement {agreementPct}</span>
      </div>
    </a>
  );
}

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}
