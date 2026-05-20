import type { Metadata } from "next";
import { TweetIntent } from "@/components/TweetIntent";
import { loadPublishedRoasts, loadRoastStats, type PublishedRoastRow } from "@/db/queries";
import { formatRelativeTime } from "@/lib/receipts";
import { RoastForm } from "./RoastForm";

export const dynamic = "force-dynamic";

const PAGE_LIMIT = 50;
const SITE_URL = "https://www.antfleet.dev";

export const metadata: Metadata = {
  title: "AntFleet · Roast my agent",
  description:
    "Submit a public GitHub repo. AntFleet reviews each submission before running the consensus pipeline; promoted roasts get findings within 24h.",
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function RoastPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const before = parseBeforeCursor(params["before"]);
  const [page, stats] = await Promise.all([
    loadPublishedRoasts(PAGE_LIMIT, before),
    loadRoastStats(),
  ]);
  const now = new Date();
  const isPaginated = before !== undefined;
  const nextCursor =
    page.hasMore && page.rows.length > 0
      ? (page.rows[page.rows.length - 1]?.publishedAt?.toISOString() ?? null)
      : null;

  return (
    <>
      <section className="py-20 pb-12">
        <ContentWrap>
          <p className="mb-6 font-mono text-xs uppercase tracking-widest text-[var(--color-ink-subtle)]">
            Roast
          </p>
          <RoastStrip stats={stats} />
          <RoastForm />
        </ContentWrap>
      </section>

      <SectionDivider />

      {page.rows.length === 0 ? (
        <EmptyRoasts isPaginated={isPaginated} />
      ) : (
        <RoastsList rows={page.rows} now={now} isPaginated={isPaginated} />
      )}

      <Pagination isPaginated={isPaginated} nextCursor={nextCursor} />

      <SectionDivider />

      <section className="pb-20">
        <ContentWrap>
          <h1 className="mb-6 text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
            What is this?
          </h1>
          <div className="max-w-xl space-y-4 text-sm leading-relaxed text-[var(--color-ink-muted)]">
            <p>Submit a public GitHub repo URL. AntFleet reviews every submission first.</p>
            <p>
              Promoted submissions go through the consensus pipeline — two frontier models read the
              code, and AntFleet publishes a finding list, severity labels, and a permanent receipt
              link within 24h.
            </p>
            <p>
              Free. Public. No accounts. Limited to 5 submissions per IP per day and 1 per repo per
              week.
            </p>
          </div>
        </ContentWrap>
      </section>
    </>
  );
}

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="border-t border-[var(--color-line)] my-16" />;
}

function RoastStrip({
  stats,
}: {
  stats: { totalPublished: number; totalFindingsFromRoasts: number; totalSubmissions: number };
}) {
  if (stats.totalSubmissions === 0) return null;

  if (stats.totalPublished === 0) {
    const n = stats.totalSubmissions;
    return (
      <p className="mb-6 font-mono text-xs text-[var(--color-ink-subtle)]">
        {n.toLocaleString()} {n === 1 ? "submission" : "submissions"} in queue · findings processing
      </p>
    );
  }

  const roasts = stats.totalPublished;
  const findings = stats.totalFindingsFromRoasts;
  return (
    <p className="mb-6 font-mono text-xs text-[var(--color-ink-subtle)]">
      {roasts.toLocaleString()} {roasts === 1 ? "repo" : "repos"} roasted to date ·{" "}
      {findings.toLocaleString()} {findings === 1 ? "finding" : "findings"} filed
    </p>
  );
}

function RoastsList({
  rows,
  now,
  isPaginated,
}: {
  rows: PublishedRoastRow[];
  now: Date;
  isPaginated: boolean;
}) {
  return (
    <section className="pb-20">
      <ContentWrap>
        <div className="mb-6 flex items-baseline justify-between">
          <h2 className="font-mono text-xs uppercase tracking-widest text-[var(--color-ink-subtle)]">
            {isPaginated ? "Older roasts" : "Latest roasts"}
          </h2>
          <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
            showing {rows.length}
          </span>
        </div>

        <ul className="flex flex-col divide-y divide-[var(--color-line)] border-t border-b border-[var(--color-line)]">
          {rows.map((row) => (
            <li key={row.id}>
              <RoastRow row={row} now={now} />
            </li>
          ))}
        </ul>
      </ContentWrap>
    </section>
  );
}

function RoastRow({ row, now }: { row: PublishedRoastRow; now: Date }) {
  const tweetUrl = `${SITE_URL}/roasts/${encodeURIComponent(row.id)}`;
  const tweetText =
    row.findingCount === 0
      ? `AntFleet just roasted ${row.repoFullName}: clean run, no findings.`
      : `AntFleet just roasted ${row.repoFullName}: ${row.findingCount} agreed finding${row.findingCount === 1 ? "" : "s"}.`;
  return (
    <div className="group -mx-3 flex flex-col gap-3 rounded-md px-3 py-5 transition-colors hover:bg-[var(--color-bg-elevated)] sm:flex-row sm:items-start sm:gap-6">
      <a
        href={`/roasts/${encodeURIComponent(row.id)}`}
        className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-start sm:gap-6"
      >
        <div className="flex flex-wrap items-center gap-2 sm:w-44 sm:shrink-0">
          <Badge>
            {row.findingCount} {row.findingCount === 1 ? "finding" : "findings"}
          </Badge>
          {row.highestSeverity !== null && <Badge>{row.highestSeverity}</Badge>}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm leading-snug text-[var(--color-ink)] underline-offset-2 group-hover:underline">
            {row.repoFullName}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
            <span>roast</span>
            {row.publishedAt !== null && (
              <>
                <span className="text-[var(--color-line-strong)]">·</span>
                <span>published {formatRelativeTime(now, row.publishedAt)}</span>
              </>
            )}
          </div>
        </div>
        <span className="font-mono text-[11px] text-[var(--color-ink-subtle)] transition-colors group-hover:text-[var(--color-ink)] sm:shrink-0 sm:self-center">
          detail →
        </span>
      </a>
      <TweetIntent
        text={tweetText}
        url={tweetUrl}
        ariaLabel={`Tweet this roast of ${row.repoFullName}`}
        className="self-start font-mono text-[11px] text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-ink)] sm:self-center sm:shrink-0"
      >
        Tweet ↗
      </TweetIntent>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-[var(--color-line-strong)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
      {children}
    </span>
  );
}

function EmptyRoasts({ isPaginated }: { isPaginated: boolean }) {
  return (
    <section className="pb-20">
      <ContentWrap>
        <div className="rounded-md border border-dashed border-[var(--color-line-strong)] p-8 text-center">
          <p className="mb-2 text-sm text-[var(--color-ink)]">
            {isPaginated ? "No older roasts." : "No roasts published yet."}
          </p>
          {!isPaginated && (
            <p className="mx-auto max-w-md text-sm leading-relaxed text-[var(--color-ink-muted)]">
              Submit a repo above — promoted submissions get findings within 24h.
            </p>
          )}
        </div>
      </ContentWrap>
    </section>
  );
}

function Pagination({
  isPaginated,
  nextCursor,
}: {
  isPaginated: boolean;
  nextCursor: string | null;
}) {
  const showBackToLatest = isPaginated;
  const showOlder = nextCursor !== null;
  if (!showBackToLatest && !showOlder) return null;

  return (
    <section className="pb-20">
      <ContentWrap>
        <nav className="flex items-center justify-between font-mono text-xs">
          {showBackToLatest ? (
            <a
              href="/roast"
              className="text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-ink)]"
            >
              ← latest roasts
            </a>
          ) : (
            <span />
          )}

          {showOlder && (
            <a
              href={`/roast?before=${encodeURIComponent(nextCursor)}`}
              className="text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-ink)]"
            >
              older →
            </a>
          )}
        </nav>
      </ContentWrap>
    </section>
  );
}

function parseBeforeCursor(raw: string | string[] | undefined): Date | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed;
}
