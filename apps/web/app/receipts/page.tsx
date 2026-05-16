import type { Metadata } from "next";
import { loadPublicReceiptsPage } from "@/db/queries";
import {
  formatRelativeTime,
  toDisplayReceipt,
  type DisplayReceipt,
} from "@/lib/receipts";

// Receipts are the moat (§18.2). The counter must be fresh on every visit —
// caching this page would let stale numbers persist past closures and break
// the live-artifact promise. Slice 4-5 adds cursor pagination (?before=<iso>),
// a last-updated stamp, and the public_receipt opt-in gate at the query
// layer so non-opted-in installs never reach this surface.
export const dynamic = "force-dynamic";

const RECENT_LIMIT = 50;

export const metadata: Metadata = {
  title: "AntFleet · Receipts",
  description:
    "Public, SHA-pinned closure receipts. Every entry is a comment on the PR that resolved it — verifiable on GitHub.",
};

// Next.js App Router server-component searchParams contract: a Promise of
// the parsed map. Values may be string, string[], or undefined.
type SearchParams = Record<string, string | string[] | undefined>;

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const before = parseBeforeCursor(params["before"]);
  const { totalClosed, recent, lastUpdatedAt, hasMore } =
    await loadPublicReceiptsPage({ limit: RECENT_LIMIT, before });
  const now = new Date();
  const displays: DisplayReceipt[] = recent.map((row) => toDisplayReceipt(row, now));
  const lastUpdatedRelative =
    lastUpdatedAt === null ? null : formatRelativeTime(now, lastUpdatedAt);
  const nextCursor =
    hasMore && displays.length > 0
      ? (displays[displays.length - 1]?.closedAtIso ?? null)
      : null;
  const isPaginated = before !== undefined;

  return (
    <>
      <ReceiptsHero
        totalClosed={totalClosed}
        lastUpdatedRelative={lastUpdatedRelative}
      />
      <SectionDivider />
      <ReceiptsList
        displays={displays}
        totalClosed={totalClosed}
        isPaginated={isPaginated}
        nextCursor={nextCursor}
      />
    </>
  );
}

// Accept the cursor only if it parses to a real Date; otherwise drop it
// silently so a malformed ?before= falls back to the latest view rather
// than 500ing the public page.
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

function ReceiptsHero({
  totalClosed,
  lastUpdatedRelative,
}: {
  totalClosed: number;
  lastUpdatedRelative: string | null;
}) {
  return (
    <section className="py-20 pb-12">
      <ContentWrap>
        <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
          Public artifact · updated live
        </p>

        <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug max-w-xl">
          Closed findings, SHA-pinned to the commit that resolved them.
        </h1>

        <div className="mt-10 flex items-baseline gap-4">
          <p className="text-6xl font-mono font-semibold tracking-tight text-[var(--color-ink)] tabular-nums">
            {totalClosed.toLocaleString()}
          </p>
          <p className="text-sm text-[var(--color-ink-muted)]">
            {totalClosed === 1 ? "receipt" : "receipts"} and counting
          </p>
        </div>

        {lastUpdatedRelative !== null && (
          <p className="mt-2 font-mono text-[11px] text-[var(--color-ink-subtle)]">
            updated {lastUpdatedRelative}
          </p>
        )}

        <p className="mt-8 text-sm text-[var(--color-ink-muted)] max-w-xl leading-relaxed">
          Every entry below is a comment on a real PR — the closure receipt
          lives on GitHub&apos;s event log, not ours. Click any link to verify
          the SHA, the timestamp, and the surrounding diff for yourself.
        </p>
      </ContentWrap>
    </section>
  );
}

function ReceiptsList({
  displays,
  totalClosed,
  isPaginated,
  nextCursor,
}: {
  displays: DisplayReceipt[];
  totalClosed: number;
  isPaginated: boolean;
  nextCursor: string | null;
}) {
  if (displays.length === 0) {
    return <EmptyReceipts isPaginated={isPaginated} totalClosed={totalClosed} />;
  }

  return (
    <section className="pb-20">
      <ContentWrap>
        <div className="mb-6 flex items-baseline justify-between">
          <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
            {isPaginated ? "Older receipts" : "Latest receipts"}
          </h2>
          <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
            showing {displays.length} of {totalClosed.toLocaleString()}
          </span>
        </div>

        <ul className="flex flex-col divide-y divide-[var(--color-line)] border-t border-b border-[var(--color-line)]">
          {displays.map((d) => (
            <li key={d.findingId}>
              <ReceiptRow display={d} />
            </li>
          ))}
        </ul>

        <Pagination isPaginated={isPaginated} nextCursor={nextCursor} />
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
    <nav className="mt-8 flex items-center justify-between font-mono text-xs">
      {showBackToLatest ? (
        <a
          href="/receipts"
          className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] transition-colors"
        >
          ← latest receipts
        </a>
      ) : (
        <span />
      )}

      {showOlder && (
        <a
          href={`/receipts?before=${encodeURIComponent(nextCursor)}`}
          className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] transition-colors"
        >
          older →
        </a>
      )}
    </nav>
  );
}

function ReceiptRow({ display }: { display: DisplayReceipt }) {
  return (
    <div className="flex flex-col gap-3 py-5 sm:flex-row sm:items-start sm:gap-6">
      {/* meta column — fixed-width on desktop, stacked on mobile */}
      <div className="flex flex-wrap items-center gap-2 sm:w-44 sm:shrink-0">
        <Badge>{display.category}</Badge>
        <Badge>{display.severity}</Badge>
      </div>

      {/* body */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[var(--color-ink)] leading-snug">{display.title}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
          <span>{display.repoLabel}</span>
          <span className="text-[var(--color-line-strong)]">·</span>
          <span>{display.prLabel}</span>
          {display.shaLabel !== null && (
            <>
              <span className="text-[var(--color-line-strong)]">·</span>
              <span>
                closed in <span className="text-[var(--color-ink-muted)]">{display.shaLabel}</span>
              </span>
            </>
          )}
          {display.relativeClosedAt !== null && (
            <>
              <span className="text-[var(--color-line-strong)]">·</span>
              <span>{display.relativeClosedAt}</span>
            </>
          )}
        </div>
      </div>

      {/* receipt link — right-aligned on desktop, full row on mobile */}
      {display.receiptUrl !== null && (
        <a
          href={display.receiptUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline underline-offset-2 sm:shrink-0 sm:self-center"
        >
          view on GitHub →
        </a>
      )}
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

function EmptyReceipts({
  isPaginated,
  totalClosed,
}: {
  isPaginated: boolean;
  totalClosed: number;
}) {
  // Two distinct empty states — falling off the end of pagination is a
  // navigation event, not a "nothing exists" event, and they should read
  // differently.
  if (isPaginated && totalClosed > 0) {
    return (
      <section className="pb-20">
        <ContentWrap>
          <div className="rounded-md border border-dashed border-[var(--color-line-strong)] p-8 text-center">
            <p className="text-sm text-[var(--color-ink)] mb-2">
              No older receipts.
            </p>
            <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed max-w-md mx-auto">
              You&apos;ve scrolled past the earliest closure on file.
            </p>
            <a
              href="/receipts"
              className="mt-5 inline-block font-mono text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline underline-offset-2 transition-colors"
            >
              ← latest receipts
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
          <p className="text-sm text-[var(--color-ink)] mb-2">No receipts yet.</p>
          <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed max-w-md mx-auto">
            The first one will appear after a finding is closed on the resolving
            commit. The daily sweeper checks open findings against{" "}
            <code className="font-mono text-xs text-[var(--color-ink)]">main</code>{" "}
            at 06:00 UTC.
          </p>
        </div>
      </ContentWrap>
    </section>
  );
}
