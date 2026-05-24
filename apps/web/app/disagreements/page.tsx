import type { Metadata } from "next";
import { TweetIntent } from "@/components/TweetIntent";
import {
  loadDisagreementsPage,
  redactSecrets,
  type DisagreementCategory,
  type DisagreementRow,
} from "@/lib/disagreements";
import { formatRelativeTime } from "@/lib/receipts";
import { shortenRepoHash } from "@/lib/short-id";

export const dynamic = "force-dynamic";

const SITE_URL = "https://www.antfleet.dev";
const RECENT_LIMIT = 50;

function disagreementTweetText(d: DisagreementRow): string {
  if (d.category === "solo_anthropic") {
    return `Opus flagged this; GPT-5 didn't mention it. We don't know who's right.`;
  }
  if (d.category === "solo_openai") {
    return `GPT-5 flagged this; Opus didn't mention it. We don't know who's right.`;
  }
  return `Both reviewers flagged the same code — different severity. Neither shipped.`;
}

export const metadata: Metadata = {
  title: "AntFleet · Disagreements",
  description:
    "Findings where AntFleet's two frontier models didn't agree. Solo flags, severity mismatches, classification conflicts — all public.",
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function DisagreementsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const before = parseBeforeCursor(params["before"]);
  const pageData = await loadDisagreementsPage({ limit: RECENT_LIMIT, before });
  const { rows, hasMore, totalCount } = pageData;
  const now = new Date();
  const nextCursor =
    hasMore && rows.length > 0 ? (rows[rows.length - 1]?.createdAt.toISOString() ?? null) : null;
  const isPaginated = before !== undefined;

  return (
    <>
      <DisagreementsHero totalCount={totalCount} />
      <SectionDivider />
      <DisagreementsList
        rows={rows}
        totalCount={totalCount}
        isPaginated={isPaginated}
        nextCursor={nextCursor}
        now={now}
      />
    </>
  );
}

function parseBeforeCursor(raw: string | string[] | undefined): Date | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed;
}

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="border-t border-[var(--color-line)] my-16" />;
}

function DisagreementsHero({ totalCount }: { totalCount: number }) {
  return (
    <section className="py-20 pb-12">
      <ContentWrap>
        <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
          Disagreements
        </p>

        <div className="flex items-baseline gap-4">
          <h1 className="text-6xl font-mono font-semibold tracking-tight text-[var(--color-ink)] tabular-nums">
            {totalCount.toLocaleString()}
          </h1>
          <p className="text-sm text-[var(--color-ink-muted)]">
            {totalCount === 1 ? "disagreement" : "disagreements"} and counting
          </p>
        </div>

        <p className="mt-8 text-sm text-[var(--color-ink-muted)] max-w-xl leading-relaxed">
          Every PR AntFleet reviews is read by two frontier models in parallel. Only the
          findings both agree on get posted. The findings they don&apos;t agree on &mdash; solo flags,
          conflicting severity calls, classification mismatches &mdash; sit in our database, normally
          invisible. They&apos;re here. We don&apos;t know which side is right; the unanimous gate
          didn&apos;t fire. Decide for yourself.
        </p>
        <p className="mt-3 text-xs text-[var(--color-ink-subtle)] max-w-xl leading-relaxed">
          See how AntFleet classifies reviewer conflicts in the{" "}
          <a
            href="/disagreements/methodology"
            className="underline underline-offset-2 hover:text-[var(--color-ink)] transition-colors"
          >
            disagreement methodology
          </a>
          .
        </p>
      </ContentWrap>
    </section>
  );
}

function DisagreementsList({
  rows,
  totalCount,
  isPaginated,
  nextCursor,
  now,
}: {
  rows: DisagreementRow[];
  totalCount: number;
  isPaginated: boolean;
  nextCursor: string | null;
  now: Date;
}) {
  if (rows.length === 0) {
    return <EmptyDisagreements isPaginated={isPaginated} totalCount={totalCount} />;
  }

  return (
    <section className="pb-20">
      <ContentWrap>
        <div className="mb-6 flex items-baseline justify-between">
          <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
            {isPaginated ? "Older disagreements" : "Latest disagreements"}
          </h2>
          <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
            showing {rows.length} of {totalCount.toLocaleString()}
          </span>
        </div>

        <ul className="flex flex-col divide-y divide-[var(--color-line)] border-t border-b border-[var(--color-line)]">
          {rows.map((row) => (
            <li key={row.id}>
              <DisagreementRowLink row={row} now={now} />
            </li>
          ))}
        </ul>

        <Pagination isPaginated={isPaginated} nextCursor={nextCursor} />
      </ContentWrap>
    </section>
  );
}

function DisagreementRowLink({ row, now }: { row: DisagreementRow; now: Date }) {
  const tweetUrl = `${SITE_URL}/disagreements/${encodeURIComponent(row.id)}`;
  return (
    <div className="group -mx-3 flex flex-col gap-3 rounded-md px-3 py-5 transition-colors hover:bg-[var(--color-bg-elevated)] sm:flex-row sm:items-start sm:gap-6">
      <a
        href={`/disagreements/${encodeURIComponent(row.id)}`}
        className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-start sm:gap-6"
      >
        <div className="flex flex-wrap items-center gap-2 sm:w-44 sm:shrink-0">
          <Badge>{categoryLabel(row.category)}</Badge>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm leading-snug text-[var(--color-ink)] underline-offset-2 group-hover:underline">
            {redactSecrets(row.primaryFinding.title)}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
            <span>repo {shortenRepoHash(row.repoHash)}</span>
            <span className="text-[var(--color-line-strong)]">·</span>
            <span>PR #{row.prNumber}</span>
            <span className="text-[var(--color-line-strong)]">·</span>
            <span>{formatRelativeTime(now, row.createdAt)}</span>
          </div>
        </div>
        <span className="font-mono text-[11px] text-[var(--color-ink-subtle)] transition-colors group-hover:text-[var(--color-ink)] sm:shrink-0 sm:self-center">
          detail →
        </span>
      </a>
      <TweetIntent
        text={disagreementTweetText(row)}
        url={tweetUrl}
        ariaLabel={`Tweet this disagreement: ${row.primaryFinding.title}`}
        className="self-start font-mono text-[11px] text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-ink)] sm:self-center sm:shrink-0"
      >
        Tweet ↗
      </TweetIntent>
    </div>
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
    <nav className="mt-8 flex items-center justify-between font-mono text-xs">
      {showBackToLatest ? (
        <a
          href="/disagreements"
          className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] transition-colors"
        >
          ← latest disagreements
        </a>
      ) : (
        <span />
      )}

      {showOlder && (
        <a
          href={`/disagreements?before=${encodeURIComponent(nextCursor)}`}
          className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] transition-colors"
        >
          older →
        </a>
      )}
    </nav>
  );
}

function EmptyDisagreements({
  isPaginated,
  totalCount,
}: {
  isPaginated: boolean;
  totalCount: number;
}) {
  if (isPaginated && totalCount > 0) {
    return (
      <section className="pb-20">
        <ContentWrap>
          <div className="rounded-md border border-dashed border-[var(--color-line-strong)] p-8 text-center">
            <p className="text-sm text-[var(--color-ink)] mb-2">No older disagreements.</p>
            <a
              href="/disagreements"
              className="mt-3 inline-block font-mono text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline underline-offset-2 transition-colors"
            >
              ← latest disagreements
            </a>
          </div>
        </ContentWrap>
      </section>
    );
  }

  return (
    <section className="pb-20">
      <ContentWrap>
        <div className="rounded-md border border-dashed border-[var(--color-line-strong)] p-8 text-center">
          <p className="text-sm text-[var(--color-ink)] mb-2">No disagreements yet.</p>
          <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed max-w-md mx-auto">
            When opted-in public reviews include solo findings or classification conflicts, they
            will appear here.
          </p>
        </div>
      </ContentWrap>
    </section>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-[var(--color-line-strong)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
      {children}
    </span>
  );
}

function categoryLabel(category: DisagreementCategory): string {
  if (category === "solo_anthropic") return "solo Opus";
  if (category === "solo_openai") return "solo GPT-5";
  return "mismatch";
}
