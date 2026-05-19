import type { Metadata } from "next";
import { TweetIntent } from "@/components/TweetIntent";
import { loadPublishedRoasts, loadRoastStats, type PublishedRoastRow } from "@/db/queries";
import { formatRelativeTime } from "@/lib/receipts";

export const dynamic = "force-dynamic";

const PAGE_LIMIT = 50;
const SITE_URL = "https://www.antfleet.dev";

export const metadata: Metadata = {
  title: "AntFleet · Roasts",
  description:
    "Public, anonymous code reviews of GitHub repos by AntFleet. Two frontier models, both agreed — every finding is verifiable.",
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function RoastsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
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
      <RoastsHero stats={stats} />
      <SectionDivider />
      {page.rows.length === 0 ? (
        <EmptyRoasts isPaginated={isPaginated} />
      ) : (
        <RoastsList rows={page.rows} now={now} isPaginated={isPaginated} />
      )}
      <Pagination isPaginated={isPaginated} nextCursor={nextCursor} />
    </>
  );
}

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="my-16 border-t border-[var(--color-line)]" />;
}

function RoastsHero({
  stats,
}: {
  stats: { totalPublished: number; totalFindingsFromRoasts: number };
}) {
  return (
    <section className="py-20 pb-12">
      <ContentWrap>
        <p className="mb-6 font-mono text-xs uppercase tracking-widest text-[var(--color-ink-subtle)]">
          Public artifact · updated live
        </p>
        <h1 className="text-3xl font-semibold leading-snug tracking-tight text-[var(--color-ink)]">
          Roasts
        </h1>
        <p className="mt-5 max-w-xl text-sm leading-relaxed text-[var(--color-ink-muted)]">
          Anonymous reviews of public GitHub repos. Two frontier models, both agreed — every finding
          here is the consensus of an independent re-run. Submit yours at{" "}
          <a
            href="/roast"
            className="underline underline-offset-2 transition-colors hover:text-[var(--color-ink)]"
          >
            /roast
          </a>
          .
        </p>
        {stats.totalPublished > 0 && (
          <p className="mt-6 font-mono text-xs text-[var(--color-ink-subtle)]">
            {stats.totalPublished.toLocaleString()} {stats.totalPublished === 1 ? "repo" : "repos"}{" "}
            roasted to date · {stats.totalFindingsFromRoasts.toLocaleString()}{" "}
            {stats.totalFindingsFromRoasts === 1 ? "finding" : "findings"} filed
          </p>
        )}
      </ContentWrap>
    </section>
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
              Submit a public GitHub repo at{" "}
              <a
                href="/roast"
                className="underline underline-offset-2 transition-colors hover:text-[var(--color-ink)]"
              >
                /roast ↗
              </a>{" "}
              — promoted submissions get findings within 24h.
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
              href="/roasts"
              className="text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-ink)]"
            >
              ← latest roasts
            </a>
          ) : (
            <span />
          )}

          {showOlder && (
            <a
              href={`/roasts?before=${encodeURIComponent(nextCursor)}`}
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
