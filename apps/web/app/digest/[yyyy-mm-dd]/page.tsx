import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TweetIntent } from "@/components/TweetIntent";
import { loadDigestForWeek, parseDigestSlug, type WeeklyDigest } from "@/lib/digest";
import {
  formatRelativeTime,
  toDisplayReceipt,
  type CrossRepoReceiptRow,
  type DisplayReceipt,
} from "@/lib/receipts";

export const dynamic = "force-dynamic";

const SITE_URL = "https://www.antfleet.dev";

type RouteParams = { "yyyy-mm-dd": string };

export async function generateMetadata({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { "yyyy-mm-dd": weekEndingIso } = await params;
  const weekEndingAt = parseDigestSlug(weekEndingIso);
  if (weekEndingAt === null) {
    return { title: "AntFleet · Digest not found" };
  }

  const since = new Date(weekEndingAt.getTime() - 7 * 24 * 60 * 60 * 1000);
  const range = `${formatIsoDate(since)} to ${weekEndingIso}`;
  const canonical = `/digest/${weekEndingIso}`;

  return {
    title: `AntFleet · week of ${weekEndingIso}`,
    description: `Weekly public-receipt digest for ${range} UTC.`,
    alternates: {
      canonical,
    },
  };
}

export default async function DigestPage({ params }: { params: Promise<RouteParams> }) {
  const { "yyyy-mm-dd": weekEndingIso } = await params;
  const digest = await loadDigestForWeek(weekEndingIso);
  if (digest === null) {
    notFound();
  }

  const now = new Date();
  const displays = digest.topClosures.map((row) => toDisplayReceipt(row, now));
  const canonicalUrl = `${SITE_URL}/digest/${weekEndingIso}`;

  return (
    <>
      <Hero digest={digest} weekEndingIso={weekEndingIso} />
      <SectionDivider />
      <WeeklyReceipts displays={displays} crossRepoReceipts={digest.crossRepoReceipts} now={now} />
      <SectionDivider />
      <ShareFooter
        digest={digest}
        displays={displays}
        crossRepoReceipts={digest.crossRepoReceipts}
        canonicalUrl={canonicalUrl}
      />
    </>
  );
}

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="my-16 border-t border-[var(--color-line)]" />;
}

function Hero({ digest, weekEndingIso }: { digest: WeeklyDigest; weekEndingIso: string }) {
  const counts = [
    ["reviews run", digest.counts.reviewsRun],
    ["findings agreed", digest.counts.findingsAgreed],
    ["receipts closed", digest.counts.receiptsClosed],
    ["reactions observed", digest.counts.reactionsObserved],
  ] as const;

  return (
    <section className="py-20 pb-12">
      <ContentWrap>
        <p className="mb-6 font-mono text-xs uppercase tracking-widest text-[var(--color-ink-subtle)]">
          Weekly digest · public-receipt installs only
        </p>
        <h1 className="max-w-xl text-3xl font-semibold leading-snug tracking-tight text-[var(--color-ink)]">
          AntFleet · week ending {weekEndingIso}
        </h1>
        <p className="mt-5 max-w-xl text-sm leading-relaxed text-[var(--color-ink-muted)]">
          Public activity from {formatIsoDate(digest.since)} through {formatIsoDate(digest.until)}{" "}
          UTC, pinned to this permalink.
        </p>
        <div className="mt-10 grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
          {counts.map(([label, value]) => (
            <div key={label}>
              <p className="font-mono text-5xl font-semibold tabular-nums tracking-tight text-[var(--color-ink)]">
                {value.toLocaleString()}
              </p>
              <p className="mt-2 font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
                {label}
              </p>
            </div>
          ))}
        </div>
      </ContentWrap>
    </section>
  );
}

function WeeklyReceipts({
  displays,
  crossRepoReceipts,
  now,
}: {
  displays: DisplayReceipt[];
  crossRepoReceipts: CrossRepoReceiptRow[];
  now: Date;
}) {
  const visibleCount = displays.length + crossRepoReceipts.length;
  return (
    <section>
      <ContentWrap>
        <div className="mb-6 flex items-baseline justify-between">
          <h2 className="font-mono text-xs uppercase tracking-widest text-[var(--color-ink-subtle)]">
            Weekly receipts
          </h2>
          <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
            {visibleCount} shown
          </span>
        </div>

        {visibleCount === 0 ? (
          <p className="border-y border-[var(--color-line)] py-5 font-mono text-sm text-[var(--color-ink-muted)]">
            no receipts this week
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--color-line)] border-y border-[var(--color-line)]">
            {displays.map((display) => (
              <li key={display.findingId}>
                <ReceiptRow display={display} />
              </li>
            ))}
            {crossRepoReceipts.map((row) => (
              <li key={row.id}>
                <CrossRepoReceiptRow row={row} now={now} />
              </li>
            ))}
          </ul>
        )}
      </ContentWrap>
    </section>
  );
}

function ReceiptRow({ display }: { display: DisplayReceipt }) {
  return (
    <a
      href={`/receipts/${encodeURIComponent(display.findingId)}`}
      className="group -mx-3 flex flex-col gap-3 rounded-md px-3 py-5 transition-colors hover:bg-[var(--color-bg-elevated)] sm:flex-row sm:items-start sm:gap-6"
    >
      <div className="flex flex-wrap items-center gap-2 sm:w-44 sm:shrink-0">
        <Badge>{display.category}</Badge>
        <Badge>{display.severity}</Badge>
      </div>
      <div className="min-w-0 flex-1">
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
                closed in <span className="text-[var(--color-ink-muted)]">{display.shaLabel}</span>
              </span>
            </>
          )}
        </div>
      </div>
      <span className="font-mono text-[11px] text-[var(--color-ink-subtle)] transition-colors group-hover:text-[var(--color-ink)] sm:shrink-0 sm:self-center">
        detail →
      </span>
    </a>
  );
}

function CrossRepoReceiptRow({ row, now }: { row: CrossRepoReceiptRow; now: Date }) {
  const shortSha = row.resolutionSha.slice(0, 7);
  const isAbsorbed = row.closureMethod === "absorbed_inline";
  return (
    <div className="group -mx-3 flex flex-col gap-3 rounded-md px-3 py-5 transition-colors hover:bg-[var(--color-bg-elevated)] sm:flex-row sm:items-start sm:gap-6">
      <a
        href={`/anatomy/${encodeURIComponent(row.sourceFindingId)}`}
        className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-start sm:gap-6"
      >
        <div className="flex flex-wrap items-center gap-2 sm:w-44 sm:shrink-0">
          <Badge>{isAbsorbed ? "fix absorbed" : "cross-repo"}</Badge>
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm leading-snug text-[var(--color-ink)] underline-offset-2 group-hover:underline">
            AntFleet → {row.upstreamOwner}/{row.upstreamRepo}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
            <span>PR #{row.upstreamPrNumber}</span>
            <span className="text-[var(--color-line-strong)]">·</span>
            <span>
              {isAbsorbed ? "absorbed at" : "merged at"}{" "}
              <span className="text-[var(--color-ink-muted)]">{shortSha}</span>
            </span>
            <span className="text-[var(--color-line-strong)]">·</span>
            <span>{formatRelativeTime(now, row.resolvedAt)}</span>
          </div>
        </div>
        <span className="font-mono text-[11px] text-[var(--color-ink-subtle)] transition-colors group-hover:text-[var(--color-ink)] sm:shrink-0 sm:self-center">
          anatomy →
        </span>
      </a>
      <a
        href={row.prUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="self-start font-mono text-[11px] text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-ink)] sm:self-center sm:shrink-0"
      >
        GitHub →
      </a>
    </div>
  );
}

function ShareFooter({
  digest,
  displays,
  crossRepoReceipts,
  canonicalUrl,
}: {
  digest: WeeklyDigest;
  displays: DisplayReceipt[];
  crossRepoReceipts: CrossRepoReceiptRow[];
  canonicalUrl: string;
}) {
  const top =
    displays[0]?.title ??
    (crossRepoReceipts[0] === undefined
      ? "no receipts"
      : `AntFleet -> ${crossRepoReceipts[0].upstreamOwner}/${crossRepoReceipts[0].upstreamRepo}`);
  const text = `AntFleet · week of ${formatIsoDate(digest.weekEndingAt)}: ${digest.counts.receiptsClosed} receipts closed across ${digest.counts.reviewsRun} reviews. Top: ${truncate(top, 80)}.`;

  return (
    <footer className="pb-20">
      <ContentWrap>
        <TweetIntent
          text={text}
          url={canonicalUrl}
          via="AntFleetDev"
          className="inline-flex rounded-md border border-[var(--color-line-strong)] px-3 py-2 font-mono text-xs text-[var(--color-ink)] transition-colors hover:bg-[var(--color-bg-elevated)]"
          ariaLabel="Tweet this weekly digest"
        >
          Tweet digest ↗
        </TweetIntent>
        <p className="mt-6 font-mono text-[11px] text-[var(--color-ink-subtle)]">
          permalink · {canonicalUrl}
        </p>
      </ContentWrap>
    </footer>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-[var(--color-line-strong)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
      {children}
    </span>
  );
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}
