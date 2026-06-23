import type { Metadata } from "next";
import { TweetIntent } from "@/components/TweetIntent";
import { loadPublicReceiptsPage } from "@/db/queries";
import { formatHoursToFix, loadPatchKpis } from "@/lib/kpis";
import {
  formatRelativeTime,
  loadCrossRepoReceipts,
  toDisplayReceipt,
  type CrossRepoReceiptRow,
  type DisplayReceipt,
} from "@/lib/receipts";

const SITE_URL = "https://www.antfleet.dev";

// Tweet copy template per plan principle 1: the number on a tweet must
// equal the number behind the link. Severity + category + repo-hash come
// from the same DisplayReceipt the row renders, so the brag matches the
// row visible on the page.
function receiptTweetText(d: DisplayReceipt): string {
  const repoHash = d.repoLabel.replace(/^repo\s+/i, "");
  const sevCat = `${d.severity} ${d.category}`.toLowerCase();
  const sha = d.shaLabel ?? "the merging PR";
  return `AntFleet caught a ${sevCat} bug in ${repoHash}. Closed in ${sha}. Two frontier models, both agreed.`;
}

// Receipts are the moat (§18.2). The counter must be fresh on every visit —
// caching this page would let stale numbers persist past closures and break
// the live-artifact promise. Slice 4-5 adds cursor pagination (?before=<iso>),
// a last-updated stamp, and the public_receipt opt-in gate at the query
// layer so non-opted-in installs never reach this surface.
export const dynamic = "force-dynamic";

const RECENT_LIMIT = 50;
const CROSS_REPO_LIMIT = 10;

export const metadata: Metadata = {
  title: "AntFleet · Receipts",
  description:
    "Public, SHA-pinned closure receipts. Every entry is a comment on the PR that resolved it — verifiable on GitHub.",
  alternates: {
    types: {
      "application/rss+xml": "/receipts.rss",
    },
  },
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
  const [pageData, crossRepo, kpis] = await Promise.all([
    loadPublicReceiptsPage({ limit: RECENT_LIMIT, before }),
    // Cross-repo receipts skip pagination — they're a curated stream
    // surfaced only on the latest view, since the corpus is small and the
    // cross-repo lifecycle is rare enough that scrolling back makes no
    // sense yet. Includes both merged and absorbed-inline rows.
    before === undefined
      ? loadCrossRepoReceipts(CROSS_REPO_LIMIT)
      : Promise.resolve({ total: 0, recent: [], lastResolvedAt: null }),
    loadPatchKpis(),
  ]);
  const { totalClosed, recent, lastUpdatedAt, hasMore } = pageData;
  const now = new Date();
  const displays: DisplayReceipt[] = recent.map((row) => toDisplayReceipt(row, now));
  // Pick the most-recent timestamp across closures, cross-repo receipts, and KPI updates.
  const candidates = [lastUpdatedAt, crossRepo.lastResolvedAt, kpis.lastUpdated].filter(
    (d): d is Date => d !== null,
  );
  const effectiveLastUpdated =
    candidates.length === 0
      ? null
      : candidates.reduce((acc, d) => (d > acc ? d : acc), candidates[0]!);
  const lastUpdatedRelative =
    effectiveLastUpdated === null ? null : formatRelativeTime(now, effectiveLastUpdated);
  const nextCursor =
    hasMore && displays.length > 0 ? (displays[displays.length - 1]?.closedAtIso ?? null) : null;
  const isPaginated = before !== undefined;
  // Aggregate findings receipts count (kept as tertiary stat under patches-landed).
  const totalReceipts = totalClosed + crossRepo.total;

  return (
    <>
      <ReceiptsHero
        patchesLanded={kpis.patchesLanded}
        reposAffected={kpis.reposAffected}
        medianHoursToFix={kpis.medianHoursToFix}
        totalReceipts={totalReceipts}
        lastUpdatedRelative={lastUpdatedRelative}
      />
      <SectionDivider />
      {crossRepo.recent.length > 0 && (
        <>
          <CrossRepoSection rows={crossRepo.recent} now={now} />
          <SectionDivider />
        </>
      )}
      <ReceiptsList
        displays={displays}
        totalClosed={totalClosed}
        isPaginated={isPaginated}
        nextCursor={nextCursor}
      />
    </>
  );
}

function CrossRepoSection({ rows, now }: { rows: CrossRepoReceiptRow[]; now: Date }) {
  return (
    <section className="pb-16">
      <ContentWrap>
        <div className="mb-6 flex items-baseline justify-between">
          <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
            Cross-repo receipts
          </h2>
          <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
            {rows.length} {rows.length === 1 ? "fix" : "fixes"} landed upstream
          </span>
        </div>
        <p className="mb-5 text-sm text-[var(--color-ink-muted)] max-w-xl leading-relaxed">
          AntFleet flagged a bug on a repo it doesn&apos;t own, and the underlying fix landed on
          upstream — whether via merge of our PR or via a separate upstream commit that applies the
          same fix. Both are receipt-eligible.
        </p>
        <ul className="flex flex-col divide-y divide-[var(--color-line)] border-t border-b border-[var(--color-line)]">
          {rows.map((row) => (
            <li key={row.id}>
              <CrossRepoRow row={row} now={now} />
            </li>
          ))}
        </ul>
      </ContentWrap>
    </section>
  );
}

function CrossRepoRow({ row, now }: { row: CrossRepoReceiptRow; now: Date }) {
  const arrowLabel = `AntFleet → ${row.upstreamOwner.toLowerCase()}/${row.upstreamRepo.toLowerCase()}`;
  const shortSha = row.resolutionSha.slice(0, 7);
  const isAbsorbed = row.closureMethod === "absorbed_inline";
  const resolvedLabel = isAbsorbed ? "fix absorbed at" : "merged at";
  // For absorbed rows, link to the upstream commit instead of the PR.
  const linkUrl = isAbsorbed
    ? `https://github.com/${row.upstreamOwner}/${row.upstreamRepo}/commit/${row.resolutionSha}`
    : row.prUrl;
  return (
    <a
      href={linkUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex flex-col gap-3 py-5 sm:flex-row sm:items-start sm:gap-6 group transition-colors hover:bg-[var(--color-bg-elevated)] -mx-3 px-3 rounded-md"
    >
      <div className="flex flex-wrap items-center gap-2 sm:w-44 sm:shrink-0">
        <span className="rounded-full border border-[var(--color-line-strong)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
          {isAbsorbed ? "fix absorbed" : "cross-repo"}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[var(--color-ink)] leading-snug group-hover:underline underline-offset-2 font-mono">
          {arrowLabel}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
          <span>PR #{row.upstreamPrNumber}</span>
          <span className="text-[var(--color-line-strong)]">·</span>
          <span>
            {resolvedLabel} <span className="text-[var(--color-ink-muted)]">{shortSha}</span>
          </span>
          <span className="text-[var(--color-line-strong)]">·</span>
          <span>{formatRelativeTime(now, row.resolvedAt)}</span>
        </div>
      </div>
      <span className="font-mono text-[11px] text-[var(--color-ink-subtle)] group-hover:text-[var(--color-ink)] transition-colors sm:shrink-0 sm:self-center">
        {isAbsorbed ? "view commit →" : "view PR →"}
      </span>
    </a>
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
  patchesLanded,
  reposAffected,
  medianHoursToFix,
  totalReceipts,
  lastUpdatedRelative,
}: {
  patchesLanded: number;
  reposAffected: number;
  medianHoursToFix: number | null;
  totalReceipts: number;
  lastUpdatedRelative: string | null;
}) {
  return (
    <section className="py-20 pb-12">
      <ContentWrap>
        <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
          Public artifact · updated live
        </p>

        <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug max-w-xl">
          Two-model consensus finds the bug. The receipt is the patch that landed.
        </h1>

        <div className="mt-10 flex items-baseline gap-4">
          <p className="text-6xl font-mono font-semibold tracking-tight text-[var(--color-ink)] tabular-nums">
            {patchesLanded.toLocaleString()}
          </p>
          <p className="text-sm text-[var(--color-ink-muted)]">
            {patchesLanded === 1 ? "patch" : "patches"} landed
            {reposAffected > 0 && (
              <>
                {" "}
                across {reposAffected.toLocaleString()} {reposAffected === 1 ? "repo" : "repos"}
              </>
            )}
          </p>
        </div>

        <div className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
          {medianHoursToFix !== null && (
            <span>
              median time to fix:{" "}
              <span className="text-[var(--color-ink-muted)]">
                {formatHoursToFix(medianHoursToFix)}
              </span>
            </span>
          )}
          <span>
            {totalReceipts.toLocaleString()} {totalReceipts === 1 ? "finding" : "findings"} on file
          </span>
          {lastUpdatedRelative !== null && <span>updated {lastUpdatedRelative}</span>}
        </div>

        <p className="mt-8 text-sm text-[var(--color-ink-muted)] max-w-xl leading-relaxed">
          Finding a bug is the easy half. The receipt is the patch that landed — merged upstream,
          SHA-pinned, verifiable on GitHub&apos;s event log. Click any row to follow the trail.
        </p>
        <p className="mt-3 text-xs text-[var(--color-ink-subtle)] max-w-xl leading-relaxed">
          Showing all public-repo receipts; private repos opt in via{" "}
          <a
            href="mailto:agent@antfleet.dev"
            className="underline underline-offset-2 hover:text-[var(--color-ink)] transition-colors"
          >
            agent@antfleet.dev
          </a>
          . Want to see all reviewer activity, not just closed findings?{" "}
          <a
            href="/benchmarks"
            className="underline underline-offset-2 hover:text-[var(--color-ink)] transition-colors"
          >
            /benchmarks
          </a>
          .
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
  const tweetUrl = `${SITE_URL}/receipts/${encodeURIComponent(display.findingId)}`;
  return (
    <div className="group -mx-3 flex flex-col gap-3 rounded-md px-3 py-5 transition-colors hover:bg-[var(--color-bg-elevated)] sm:flex-row sm:items-start sm:gap-6">
      <a
        href={`/receipts/${encodeURIComponent(display.findingId)}`}
        className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-start sm:gap-6 min-w-0"
      >
        {/* meta column — fixed-width on desktop, stacked on mobile */}
        <div className="flex flex-wrap items-center gap-2 sm:w-44 sm:shrink-0">
          <Badge>{display.category}</Badge>
          <Badge>{display.severity}</Badge>
          {display.label && display.label !== "blocking" && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 capitalize">
              {display.label}
            </span>
          )}
        </div>

        {/* body */}
        <div className="flex-1 min-w-0">
          <p className="text-sm leading-snug text-[var(--color-ink)] underline-offset-2 group-hover:underline">
            {display.title}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
            <span>{display.repoLabel}</span>
            <span className="text-[var(--color-line-strong)]">·</span>
            <span>{display.prLabel}</span>
            {display.shaLabel !== null && (
              <>
                <span className="text-[var(--color-line-strong)]">·</span>
                <span>
                  closed in{" "}
                  <span className="text-[var(--color-ink-muted)]">{display.shaLabel}</span>
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

        {/* affordance — right-aligned on desktop */}
        <span className="font-mono text-[11px] text-[var(--color-ink-subtle)] transition-colors group-hover:text-[var(--color-ink)] sm:shrink-0 sm:self-center">
          detail →
        </span>
      </a>
      <a
        href={`/anatomy/${encodeURIComponent(display.findingId)}`}
        className="self-start font-mono text-[11px] text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-ink)] sm:self-center sm:shrink-0"
      >
        anatomy &rarr;
      </a>
      <TweetIntent
        text={receiptTweetText(display)}
        url={tweetUrl}
        ariaLabel={`Tweet this receipt: ${display.title}`}
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
            <p className="text-sm text-[var(--color-ink)] mb-2">No older receipts.</p>
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
            The first one will appear after a finding is closed on the resolving commit. The daily
            sweeper checks open findings against{" "}
            <code className="font-mono text-xs text-[var(--color-ink)]">main</code> at 06:00 UTC.
          </p>
        </div>
      </ContentWrap>
    </section>
  );
}
