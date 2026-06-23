import type { Metadata } from "next";
import { formatHoursToFix, loadPatchKpis } from "@/lib/kpis";
import {
  formatRelativeTime,
  loadCrossRepoReceipts,
  type CrossRepoReceiptRow,
} from "@/lib/receipts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AntFleet · Impact",
  description:
    "Upstream bugs fixed by AntFleet. Every row is a receipt-eligible fix on a repo AntFleet doesn't own.",
};

export default async function ImpactPage() {
  const [crossRepo, kpis] = await Promise.all([loadCrossRepoReceipts(100), loadPatchKpis()]);
  const now = new Date();

  const uniqueRepos = new Set(crossRepo.recent.map((r) => `${r.upstreamOwner}/${r.upstreamRepo}`));

  return (
    <>
      <section className="py-20 pb-12">
        <ContentWrap>
          <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
            Upstream fixes · verified on GitHub
          </p>

          <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug max-w-xl">
            Bugs AntFleet found — and maintainers fixed.
          </h1>

          <p className="mt-6 text-sm text-[var(--color-ink-muted)] max-w-xl leading-relaxed">
            Every row below is an upstream fix on a repo AntFleet doesn&apos;t own: either a merged
            pull request or an absorbed-inline fix. The upstream maintainer reviewed the change
            independently and accepted it. This is the highest-trust receipt class — a third party
            confirmed the bug was real.
          </p>

          {crossRepo.total > 0 && (
            <div className="mt-10 flex items-baseline gap-6">
              <div>
                <p className="text-4xl font-mono font-semibold tracking-tight text-[var(--color-ink)] tabular-nums">
                  {crossRepo.total}
                </p>
                <p className="mt-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
                  {crossRepo.total === 1 ? "fix landed" : "fixes landed"}
                </p>
              </div>
              <div>
                <p className="text-4xl font-mono font-semibold tracking-tight text-[var(--color-ink)] tabular-nums">
                  {uniqueRepos.size}
                </p>
                <p className="mt-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
                  {uniqueRepos.size === 1 ? "repo" : "repos"} affected
                </p>
              </div>
              {kpis.medianHoursToFix !== null && (
                <div>
                  <p className="text-4xl font-mono font-semibold tracking-tight text-[var(--color-ink)] tabular-nums">
                    {formatHoursToFix(kpis.medianHoursToFix)}
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
                    median time to fix
                  </p>
                </div>
              )}
            </div>
          )}
        </ContentWrap>
      </section>

      <SectionDivider />

      {crossRepo.recent.length === 0 ? (
        <EmptyState />
      ) : (
        <UpstreamList rows={crossRepo.recent} now={now} />
      )}
    </>
  );
}

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="border-t border-[var(--color-line)] my-16" />;
}

function UpstreamList({ rows, now }: { rows: CrossRepoReceiptRow[]; now: Date }) {
  return (
    <section className="pb-20">
      <ContentWrap>
        <div className="mb-6 flex items-baseline justify-between">
          <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
            Upstream fixes
          </h2>
          <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
            {rows.length} {rows.length === 1 ? "fix" : "fixes"}
          </span>
        </div>

        <ul className="flex flex-col divide-y divide-[var(--color-line)] border-t border-b border-[var(--color-line)]">
          {rows.map((row) => (
            <li key={row.id}>
              <UpstreamRow row={row} now={now} />
            </li>
          ))}
        </ul>

        <p className="mt-8 text-sm text-[var(--color-ink-muted)]">
          See all findings on the{" "}
          <a
            href="/receipts"
            className="underline underline-offset-2 hover:text-[var(--color-ink)] transition-colors"
          >
            receipts page
          </a>
          .
        </p>
      </ContentWrap>
    </section>
  );
}

function UpstreamRow({ row, now }: { row: CrossRepoReceiptRow; now: Date }) {
  const arrowLabel = `AntFleet → ${row.upstreamOwner}/${row.upstreamRepo}`;
  const shortSha = row.resolutionSha.slice(0, 7);
  const isAbsorbed = row.closureMethod === "absorbed_inline";
  const resolvedLabel = isAbsorbed ? "fix absorbed at" : "merged at";
  return (
    <div className="group -mx-3 flex flex-col gap-3 rounded-md px-3 py-5 transition-colors hover:bg-[var(--color-bg-elevated)] sm:flex-row sm:items-start sm:gap-6">
      <a
        href={`/anatomy/${encodeURIComponent(row.sourceFindingId)}`}
        className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-start sm:gap-6 min-w-0"
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

function EmptyState() {
  return (
    <section className="pb-20">
      <ContentWrap>
        <div className="rounded-md border border-dashed border-[var(--color-line-strong)] p-8 text-center">
          <p className="text-sm text-[var(--color-ink)] mb-2">No upstream fixes yet.</p>
          <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed max-w-md mx-auto">
            When AntFleet finds a bug on a repo it doesn&apos;t own and the maintainer merges the
            fix, it appears here.
          </p>
        </div>
      </ContentWrap>
    </section>
  );
}
