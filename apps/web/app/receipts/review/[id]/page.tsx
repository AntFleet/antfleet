import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadPublicReviewReceipt } from "@/db/queries";
import { shortenRepoHash, shortenSha } from "@/lib/short-id";

export const dynamic = "force-dynamic";

type RouteParams = { id: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { id } = await params;
  const row = await loadPublicReviewReceipt(id);
  if (row === null) return { title: "AntFleet · Review receipt not found" };
  return {
    title: `AntFleet · Review ${id.slice(0, 8)}`,
    description: `${repoLabel(row)} PR #${row.prNumber} · ${row.jobStatus ?? row.processingStatus}`,
  };
}

export default async function ReviewReceiptPage({ params }: { params: Promise<RouteParams> }) {
  const { id } = await params;
  const row = await loadPublicReviewReceipt(id);
  if (row === null) notFound();

  return (
    <>
      <section className="py-20 pb-12">
        <ContentWrap>
          <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
            Review receipt · {row.reviewId}
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug">
            {repoLabel(row)} PR #{row.prNumber}
          </h1>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Badge>{row.paymentRail ?? "channel"}</Badge>
            <Badge>{row.jobStatus ?? row.processingStatus}</Badge>
            {row.failureMode !== null && <Badge>{row.failureMode}</Badge>}
            <Badge>{settlementLabel(row)}</Badge>
          </div>
          <div className="mt-6 font-mono text-[11px] text-[var(--color-ink-subtle)] flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>SHA {shortenSha(row.commitSha)}</span>
            <span className="text-[var(--color-line-strong)]">·</span>
            <span>paid_via: {row.paymentRail ?? "channel"}</span>
            {row.jobId !== null && (
              <>
                <span className="text-[var(--color-line-strong)]">·</span>
                <span>job {row.jobId}</span>
              </>
            )}
          </div>
        </ContentWrap>
      </section>

      <SectionDivider />

      <section>
        <ContentWrap>
          <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
            Findings
          </h2>
          {row.findings.length === 0 ? (
            <p className="text-sm text-[var(--color-ink-muted)]">
              {row.failureMode === null ? "No findings - clean review." : row.failureMessage}
            </p>
          ) : (
            <div className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] divide-y divide-[var(--color-line)]">
              {row.findings.map((finding) => (
                <Link
                  key={finding.findingId}
                  href={`/receipts/${finding.findingId}`}
                  className="block px-5 py-4 hover:bg-[var(--color-bg-muted)]"
                >
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <Badge>{finding.severity}</Badge>
                    <Badge>{finding.category}</Badge>
                    <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
                      {finding.findingId}
                    </span>
                  </div>
                  <p className="text-sm text-[var(--color-ink)]">{finding.title}</p>
                </Link>
              ))}
            </div>
          )}
        </ContentWrap>
      </section>

      <SectionDivider />

      <section className="pb-20">
        <ContentWrap>
          <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
            Settlement
          </h2>
          <dl className="grid grid-cols-1 gap-3 text-sm text-[var(--color-ink-muted)] sm:grid-cols-[160px_1fr]">
            <dt className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
              Status
            </dt>
            <dd>{settlementLabel(row)}</dd>
            <dt className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
              Wallet
            </dt>
            <dd className="font-mono break-all">{row.callerWallet ?? "channel installation"}</dd>
            <dt className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
              Pay to
            </dt>
            <dd className="font-mono break-all">{row.x402PayTo ?? "channel treasury"}</dd>
          </dl>
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

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-[var(--color-line-strong)] px-2 py-1 font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
      {children}
    </span>
  );
}

function repoLabel(row: { owner: string | null; repo: string | null; repoHash: string }): string {
  if (row.owner !== null && row.repo !== null) return `${row.owner}/${row.repo}`;
  return `repo ${shortenRepoHash(row.repoHash)}`;
}

function settlementLabel(row: { settlementStatus: string | null }): string {
  return row.settlementStatus ?? "pending";
}
