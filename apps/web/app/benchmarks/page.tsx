import type { Metadata } from "next";
import { loadPublicBenchmarksPage, type PublicBenchmarkRow } from "@/db/queries";
import { formatRelativeTime } from "@/lib/receipts";

// Mission 6 — benchmark surface. Lists reviews on benchmark-class repos
// (BENCHMARK.md at root) regardless of close state. Sibling to /receipts:
// /receipts is the "AntFleet caught it, it got fixed" catalog; /benchmarks
// is the "AntFleet ran on this code" catalog. Both gate on
// public_receipt = true; this one additionally requires is_benchmark = true.
//
// v1: no per-benchmark detail pages — the GitHub PR comment is the
// canonical artifact and each row links straight to it. Add detail pages
// later if a rich embed becomes useful.
export const dynamic = "force-dynamic";

const PAGE_LIMIT = 50;

export const metadata: Metadata = {
  title: "AntFleet · Benchmarks",
  description:
    "Two-model PR reviews on benchmark-class repos. Every row links to the actual GitHub comment — verifiable against the upstream diff.",
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function BenchmarksPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const before = parseBeforeCursor(params["before"]);
  const { totalBenchmarks, recent, lastUpdatedAt, hasMore } = await loadPublicBenchmarksPage({
    limit: PAGE_LIMIT,
    before,
  });
  const now = new Date();
  const lastUpdatedRelative =
    lastUpdatedAt === null ? null : formatRelativeTime(now, lastUpdatedAt);
  const nextCursor =
    hasMore && recent.length > 0
      ? recent[recent.length - 1]?.createdAt.toISOString() ?? null
      : null;
  const isPaginated = before !== undefined;

  return (
    <>
      <BenchmarksHero
        totalBenchmarks={totalBenchmarks}
        lastUpdatedRelative={lastUpdatedRelative}
      />
      <SectionDivider />
      <BenchmarksList
        rows={recent}
        totalBenchmarks={totalBenchmarks}
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

function BenchmarksHero({
  totalBenchmarks,
  lastUpdatedRelative,
}: {
  totalBenchmarks: number;
  lastUpdatedRelative: string | null;
}) {
  return (
    <section className="py-20 pb-12">
      <ContentWrap>
        <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
          Public benchmarks · updated live
        </p>

        <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug max-w-xl">
          Every two-model review AntFleet ran on a benchmark-class repo.
        </h1>

        <div className="mt-10 flex items-baseline gap-4">
          <p className="text-6xl font-mono font-semibold tracking-tight text-[var(--color-ink)] tabular-nums">
            {totalBenchmarks.toLocaleString()}
          </p>
          <p className="text-sm text-[var(--color-ink-muted)]">
            {totalBenchmarks === 1 ? "benchmark" : "benchmarks"} and counting
          </p>
        </div>

        {lastUpdatedRelative !== null && (
          <p className="mt-2 font-mono text-[11px] text-[var(--color-ink-subtle)]">
            updated {lastUpdatedRelative}
          </p>
        )}

        <p className="mt-8 text-sm text-[var(--color-ink-muted)] max-w-xl leading-relaxed">
          Benchmark-class repos are public repos with a{" "}
          <code className="font-mono text-xs text-[var(--color-ink)]">BENCHMARK.md</code>{" "}
          file at the root. PRs there are not meant to merge — they exist to
          run a known diff past AntFleet&apos;s two-model unanimous consensus and
          publish the result. Click any row to read the bot review on GitHub.
        </p>
        <p className="mt-3 text-xs text-[var(--color-ink-subtle)] max-w-xl leading-relaxed">
          Looking for closed-finding receipts instead?{" "}
          <a
            href="/receipts"
            className="underline underline-offset-2 hover:text-[var(--color-ink)] transition-colors"
          >
            /receipts
          </a>
          .
        </p>
      </ContentWrap>
    </section>
  );
}

function BenchmarksList({
  rows,
  totalBenchmarks,
  isPaginated,
  nextCursor,
  now,
}: {
  rows: PublicBenchmarkRow[];
  totalBenchmarks: number;
  isPaginated: boolean;
  nextCursor: string | null;
  now: Date;
}) {
  if (rows.length === 0) {
    return <EmptyBenchmarks isPaginated={isPaginated} totalBenchmarks={totalBenchmarks} />;
  }

  return (
    <section className="pb-20">
      <ContentWrap>
        <div className="mb-6 flex items-baseline justify-between">
          <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
            {isPaginated ? "Older benchmarks" : "Latest benchmarks"}
          </h2>
          <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
            showing {rows.length} of {totalBenchmarks.toLocaleString()}
          </span>
        </div>

        <ul className="flex flex-col divide-y divide-[var(--color-line)] border-t border-b border-[var(--color-line)]">
          {rows.map((r) => (
            <li key={r.reviewId}>
              <BenchmarkRow row={r} now={now} />
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
          href="/benchmarks"
          className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] transition-colors"
        >
          ← latest benchmarks
        </a>
      ) : (
        <span />
      )}

      {showOlder && (
        <a
          href={`/benchmarks?before=${encodeURIComponent(nextCursor)}`}
          className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] transition-colors"
        >
          older →
        </a>
      )}
    </nav>
  );
}

function BenchmarkRow({ row, now }: { row: PublicBenchmarkRow; now: Date }) {
  // Primary link priority: bot's review comment URL if the bot posted one
  // (i.e. there were findings); otherwise the PR itself. Whichever the
  // operator follows, it lands on a verifiable GitHub artifact.
  const ownerRepo = row.owner !== null && row.repo !== null ? `${row.owner}/${row.repo}` : null;
  const prUrl =
    ownerRepo === null ? null : `https://github.com/${ownerRepo}/pull/${row.prNumber}`;
  const primaryHref = row.prCommentUrl ?? prUrl;
  const relative = formatRelativeTime(now, row.createdAt);
  const findingLabel =
    row.findingCount === 0
      ? "0 findings (clean)"
      : `${row.findingCount} finding${row.findingCount === 1 ? "" : "s"}`;
  const fileCount = row.filesReviewed.length;
  const modelLabels = Object.values(row.modelIds).filter((m) => typeof m === "string" && m.length > 0);

  const content = (
    <div className="flex flex-col gap-3 py-5 sm:flex-row sm:items-start sm:gap-6 group">
      {/* meta column */}
      <div className="flex flex-wrap items-center gap-2 sm:w-44 sm:shrink-0">
        <Badge>{findingLabel}</Badge>
        {fileCount > 0 && (
          <Badge>
            {fileCount} file{fileCount === 1 ? "" : "s"}
          </Badge>
        )}
      </div>

      {/* body */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[var(--color-ink)] leading-snug group-hover:underline underline-offset-2">
          {ownerRepo ?? `review ${row.reviewId.slice(0, 8)}`} · PR #{row.prNumber}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
          {modelLabels.map((m, i) => (
            <span key={i} className="text-[var(--color-ink-muted)]">
              {m}
            </span>
          ))}
          {modelLabels.length > 0 && (
            <span className="text-[var(--color-line-strong)]">·</span>
          )}
          <span>commit {row.commitSha.slice(0, 7)}</span>
          <span className="text-[var(--color-line-strong)]">·</span>
          <span>{relative}</span>
        </div>
      </div>

      <span className="font-mono text-[11px] text-[var(--color-ink-subtle)] group-hover:text-[var(--color-ink)] transition-colors sm:shrink-0 sm:self-center">
        {row.prCommentUrl !== null ? "review →" : "PR →"}
      </span>
    </div>
  );

  if (primaryHref === null) {
    return (
      <div className="-mx-3 px-3 rounded-md transition-colors">{content}</div>
    );
  }
  return (
    <a
      href={primaryHref}
      target="_blank"
      rel="noopener noreferrer"
      className="block hover:bg-[var(--color-bg-elevated)] -mx-3 px-3 rounded-md transition-colors"
    >
      {content}
    </a>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-[var(--color-line-strong)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
      {children}
    </span>
  );
}

function EmptyBenchmarks({
  isPaginated,
  totalBenchmarks,
}: {
  isPaginated: boolean;
  totalBenchmarks: number;
}) {
  if (isPaginated && totalBenchmarks > 0) {
    return (
      <section className="pb-20">
        <ContentWrap>
          <div className="rounded-md border border-dashed border-[var(--color-line-strong)] p-8 text-center">
            <p className="text-sm text-[var(--color-ink)] mb-2">No older benchmarks.</p>
            <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed max-w-md mx-auto">
              You&apos;ve scrolled past the earliest benchmark on file.
            </p>
            <a
              href="/benchmarks"
              className="mt-5 inline-block font-mono text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline underline-offset-2 transition-colors"
            >
              ← latest benchmarks
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
          <p className="text-sm text-[var(--color-ink)] mb-2">No benchmarks yet.</p>
          <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed max-w-md mx-auto">
            AntFleet benchmarks public repos that include a{" "}
            <code className="font-mono text-xs text-[var(--color-ink)]">BENCHMARK.md</code>{" "}
            file at the root. The first benchmark will appear after AntFleet
            reviews a PR on such a repo.
          </p>
        </div>
      </ContentWrap>
    </section>
  );
}
