import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadPublicReceiptDetail } from "@/db/queries";
import { toDisplayReceiptDetail } from "@/lib/receipts";

// Single-receipt detail surface. Reads finding_status WHERE finding_id = id
// AND reviews.public_receipt = true (404 if either fails). Surfaces the full
// agent attribution that the list page abbreviates — model versions, per-
// provider timing, the full finding body, the closure lag. Same privacy
// boundary: only repo_hash crosses, never owner/repo.
export const dynamic = "force-dynamic";

type RouteParams = { id: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { id } = await params;
  const row = await loadPublicReceiptDetail(id);
  if (row === null) {
    return { title: "AntFleet · Receipt not found" };
  }
  return {
    title: `AntFleet · ${row.title}`,
    description: `${row.category} · ${row.severity} — closed in ${row.closureSha?.slice(0, 7) ?? "main"}`,
  };
}

export default async function ReceiptDetailPage({ params }: { params: Promise<RouteParams> }) {
  const { id } = await params;
  const row = await loadPublicReceiptDetail(id);
  if (row === null) {
    notFound();
  }
  const detail = toDisplayReceiptDetail(row, new Date());

  return (
    <>
      <Header detail={detail} />
      <SectionDivider />
      <FindingBody detail={detail} />
      <SectionDivider />
      <AgentAttribution detail={detail} />
      <SectionDivider />
      <ReceiptLinks detail={detail} />
    </>
  );
}

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="border-t border-[var(--color-line)] my-16" />;
}

function Header({ detail }: { detail: ReturnType<typeof toDisplayReceiptDetail> }) {
  return (
    <section className="py-20 pb-12">
      <ContentWrap>
        <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
          Receipt · {detail.findingId}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug">
          {detail.finding.title}
        </h1>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Badge>{detail.finding.category}</Badge>
          <Badge>{detail.finding.severity}</Badge>
          {detail.shaLabel !== null && <Badge>closed in {detail.shaLabel}</Badge>}
          {detail.closureLagText !== null && <Badge>{detail.closureLagText}</Badge>}
        </div>
        <div className="mt-6 font-mono text-[11px] text-[var(--color-ink-subtle)] flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>{detail.repoLabel}</span>
          <span className="text-[var(--color-line-strong)]">·</span>
          <span>{detail.prLabel}</span>
          <span className="text-[var(--color-line-strong)]">·</span>
          <span>reviewed {detail.relativeReviewedAt}</span>
          {detail.relativeClosedAt !== null && (
            <>
              <span className="text-[var(--color-line-strong)]">·</span>
              <span>{detail.relativeClosedAt}</span>
            </>
          )}
        </div>
      </ContentWrap>
    </section>
  );
}

function FindingBody({ detail }: { detail: ReturnType<typeof toDisplayReceiptDetail> }) {
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
          The finding
        </h2>
        <div className="flex flex-col gap-5 max-w-xl text-sm text-[var(--color-ink-muted)] leading-relaxed">
          {detail.finding.evidence.length > 0 && (
            <ul className="font-mono text-xs flex flex-col gap-1">
              {detail.finding.evidence.map((ev, i) => (
                <li key={i} className="text-[var(--color-ink)]">
                  {formatEvidencePath(ev)}
                </li>
              ))}
            </ul>
          )}
          {detail.finding.reasoning !== null && (
            <blockquote className="border-l-2 border-[var(--color-line-strong)] pl-4">
              {detail.finding.reasoning}
            </blockquote>
          )}
          {detail.finding.recommendation !== null && (
            <div>
              <p className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-1">
                Fix
              </p>
              <p>{detail.finding.recommendation}</p>
            </div>
          )}
        </div>
      </ContentWrap>
    </section>
  );
}

function AgentAttribution({ detail }: { detail: ReturnType<typeof toDisplayReceiptDetail> }) {
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
          Agent attribution
        </h2>
        <p className="text-sm text-[var(--color-ink-muted)] mb-6 max-w-xl leading-relaxed">
          The agents that produced this receipt — both reviewer models had to flag this
          independently for the agreement gate to emit it.
        </p>

        <div className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] divide-y divide-[var(--color-line)]">
          {detail.providerTimings.length > 0
            ? detail.providerTimings.map((t) => (
                <div
                  key={t.name}
                  className="px-5 py-4 grid grid-cols-1 gap-1 sm:grid-cols-[140px_1fr_auto] sm:gap-4 sm:items-baseline"
                >
                  <p className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
                    {t.name}
                  </p>
                  <p className="text-sm text-[var(--color-ink)] font-mono">
                    {modelLabelForProvider(t.name, detail.reviewerLabels)}
                  </p>
                  <p className="font-mono text-[11px] text-[var(--color-ink-subtle)] sm:text-right">
                    {t.ms === null ? "—" : `${(t.ms / 1000).toFixed(1)}s`}
                    {!t.ok && " · error"}
                  </p>
                </div>
              ))
            : detail.reviewerLabels.map((label, i) => (
                <div key={i} className="px-5 py-4">
                  <p className="text-sm text-[var(--color-ink)] font-mono">{label}</p>
                </div>
              ))}
          <div className="px-5 py-4 grid grid-cols-1 gap-1 sm:grid-cols-[140px_1fr_auto] sm:gap-4 sm:items-baseline">
            <p className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
              Total
            </p>
            <p className="text-sm text-[var(--color-ink-muted)]">
              wall-clock review time · est. inference cost
            </p>
            <p className="font-mono text-[11px] text-[var(--color-ink-subtle)] sm:text-right">
              {(detail.totalReviewMs / 1000).toFixed(1)}s · $
              {Number(detail.estimatedCostUsd).toFixed(2)}
            </p>
          </div>
          <div className="px-5 py-4 grid grid-cols-1 gap-1 sm:grid-cols-[140px_1fr_auto] sm:gap-4 sm:items-baseline">
            <p className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
              Sweeper
            </p>
            <p className="text-sm text-[var(--color-ink-muted)]">
              closed at SHA{detail.shaLabel !== null && ` ${detail.shaLabel}`}
            </p>
            <p className="font-mono text-[11px] text-[var(--color-ink-subtle)] sm:text-right">
              {detail.closureLagText ?? "still open"}
            </p>
          </div>
        </div>
        <p className="mt-3 font-mono text-[11px] text-[var(--color-ink-subtle)]">
          internal review id ·{" "}
          <span className="text-[var(--color-ink-muted)]">{detail.reviewIdShort}</span>
        </p>
      </ContentWrap>
    </section>
  );
}

function ReceiptLinks({ detail }: { detail: ReturnType<typeof toDisplayReceiptDetail> }) {
  return (
    <section className="pb-20">
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
          Third-party witnesses
        </h2>
        <p className="text-sm text-[var(--color-ink-muted)] mb-5 max-w-xl leading-relaxed">
          Everything below lives on GitHub&apos;s event log, not ours. Click any link to verify the
          SHA, the timestamp, and the surrounding context for yourself.
        </p>
        <ul className="flex flex-col gap-3">
          {detail.receiptUrl !== null && (
            <LinkRow label="Closure receipt comment" href={detail.receiptUrl} />
          )}
          {detail.originalCommentUrl !== null && (
            <LinkRow label="Original review comment" href={detail.originalCommentUrl} />
          )}
          {detail.prLinkUrl !== null && (
            <LinkRow label="The pull request" href={detail.prLinkUrl} />
          )}
        </ul>

        <div className="mt-10 flex flex-col gap-3">
          <a
            href={`/anatomy/${encodeURIComponent(detail.findingId)}`}
            className="font-mono text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline underline-offset-2 transition-colors"
          >
            full anatomy &rarr;
          </a>
          <a
            href="/receipts"
            className="font-mono text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline underline-offset-2 transition-colors"
          >
            &larr; back to all receipts
          </a>
        </div>
      </ContentWrap>
    </section>
  );
}

function LinkRow({ label, href }: { label: string; href: string }) {
  return (
    <li className="rounded-md border border-[var(--color-line)] px-4 py-3 flex flex-col gap-1">
      <p className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
        {label}
      </p>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-[var(--color-ink)] hover:opacity-70 transition-opacity break-all underline underline-offset-2"
      >
        {href}
      </a>
    </li>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-[var(--color-line-strong)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
      {children}
    </span>
  );
}

function formatEvidencePath(ev: {
  path: string;
  startLine: number | null;
  endLine: number | null;
}): string {
  if (ev.startLine === null) return ev.path;
  if (ev.endLine === null || ev.endLine === ev.startLine) {
    return `${ev.path}:${ev.startLine}`;
  }
  return `${ev.path}:${ev.startLine}-${ev.endLine}`;
}

// Provider names in provider_responses don't always match the human-friendly
// model ids stored in provider_model_ids. Best-effort lookup: if the provider
// name is a key on provider_model_ids return that value; otherwise return the
// first reviewer label as a fallback.
function modelLabelForProvider(providerName: string, allLabels: string[]): string {
  // Heuristic: provider name (e.g., "anthropic") often appears as a substring
  // of the model id ("claude-opus-4-7"). When it doesn't, fall back to
  // matching by position (anthropic first, openai second per pipeline order).
  for (const label of allLabels) {
    if (label.toLowerCase().includes(providerName.toLowerCase())) return label;
  }
  if (providerName.toLowerCase() === "anthropic") {
    return allLabels[0] ?? providerName;
  }
  if (providerName.toLowerCase() === "openai") {
    return allLabels[1] ?? providerName;
  }
  return providerName;
}
