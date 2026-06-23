import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadPublicFindingEvidenceBundle, loadPublicReceiptDetail } from "@/db/queries";
import type { PublicReceiptDetailRow } from "@/db/queries";
import { isEvidenceBundleEnabled } from "@/lib/daybreak-gates-env";
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
  // Retracted: deindex and strip the claim from the title/description so a
  // stale SERP snippet can't keep advertising it (mirrors the anatomy page).
  if (row.retractedAt !== null) {
    return {
      title: "AntFleet · Retracted finding",
      description: "This finding has been retracted and is no longer a current AntFleet advisory.",
      robots: { index: false, follow: false },
    };
  }
  if (!isPublicClosedReceipt(row)) {
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
  // Retracted findings keep their URL live (HTTP 200) but render only a
  // retraction notice — no claim title, severity, body, or agent attribution
  // (all of which are indexable). noindex is set in generateMetadata.
  if (row.retractedAt !== null) {
    return <RetractedReceiptNotice findingId={row.findingId} reason={row.retractionReason} />;
  }
  if (!isPublicClosedReceipt(row)) {
    notFound();
  }
  const evidenceEnabled = isEvidenceBundleEnabled();
  const bundle = evidenceEnabled ? await loadPublicFindingEvidenceBundle(id) : null;
  const detail = toDisplayReceiptDetail(row, new Date());
  const status = evidenceStatus(bundle);

  return (
    <>
      <Header detail={detail} evidenceCompleteness={evidenceEnabled ? status : null} />
      <SectionDivider />
      <FindingBody detail={detail} />
      {evidenceEnabled && (
        <>
          <SectionDivider />
          <EvidenceBlock bundle={bundle} />
        </>
      )}
      <SectionDivider />
      <AgentAttribution detail={detail} />
      <SectionDivider />
      <ReceiptLinks detail={detail} />
    </>
  );
}

function RetractedReceiptNotice({
  findingId,
  reason,
}: {
  findingId: string;
  reason: string | null;
}) {
  const body =
    reason !== null && reason.length > 0
      ? reason
      : "The finding did not survive post-publication review.";
  return (
    <section className="py-20">
      <ContentWrap>
        <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
          Receipt · {findingId}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug">
          This finding has been retracted
        </h1>
        <div className="mt-8 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] p-6 max-w-xl">
          <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed">{body}</p>
          <p className="mt-4 text-sm text-[var(--color-ink-muted)] leading-relaxed">
            If you have questions, contact{" "}
            <a
              href="mailto:privacy@antfleet.dev"
              className="underline underline-offset-2 text-[var(--color-ink)] hover:opacity-70 transition-opacity"
            >
              privacy@antfleet.dev
            </a>
            .
          </p>
        </div>
        <div className="mt-10 font-mono text-xs">
          <a
            href="/receipts"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline underline-offset-2 transition-colors"
          >
            all receipts &rarr;
          </a>
        </div>
      </ContentWrap>
    </section>
  );
}

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="border-t border-[var(--color-line)] my-16" />;
}

function Header({
  detail,
  evidenceCompleteness,
}: {
  detail: ReturnType<typeof toDisplayReceiptDetail>;
  evidenceCompleteness: EvidenceStatus | null;
}) {
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
          {evidenceCompleteness !== null && (
            <Badge>{evidenceBadgeLabel(evidenceCompleteness)}</Badge>
          )}
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

type PublicEvidenceBundle = Awaited<ReturnType<typeof loadPublicFindingEvidenceBundle>>;
type EvidenceStatus = "complete" | "partial" | "empty";

function EvidenceBlock({ bundle }: { bundle: PublicEvidenceBundle }) {
  const status = evidenceStatus(bundle);
  const poc = slotText(bundle?.pocSnippet, "text");
  const repro = slotText(bundle?.reproductionCommand, "command");
  const trace = callPathLines(bundle?.callPathTrace);

  return (
    <section>
      <ContentWrap>
        <details className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)]">
          <summary className="cursor-pointer list-none px-5 py-4 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
              Evidence
            </span>
            <Badge>{evidenceBadgeLabel(status)}</Badge>
          </summary>
          <div className="border-t border-[var(--color-line)] divide-y divide-[var(--color-line)]">
            <EvidenceSlot label="PoC" value={poc} empty="not attached" />
            <EvidenceSlot label="Repro" value={repro} empty="not attached" mono />
            <div className="px-5 py-4 grid grid-cols-1 gap-2 sm:grid-cols-[120px_1fr] sm:gap-5">
              <p className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
                Call path
              </p>
              {trace.length > 0 ? (
                <ol className="flex flex-col gap-1 font-mono text-xs text-[var(--color-ink)]">
                  {trace.map((line, i) => (
                    <li key={`${line}-${i}`}>{line}</li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-[var(--color-ink-subtle)]">not attached</p>
              )}
            </div>
            {bundle !== null && (
              <div className="px-5 py-3 font-mono text-[11px] text-[var(--color-ink-subtle)] flex flex-wrap gap-x-3 gap-y-1">
                <span>sha {bundle.affectedSha.slice(0, 12)}</span>
                <span>attempt {bundle.reviewAttempt}</span>
                <span>updated {bundle.updatedAt.toISOString()}</span>
              </div>
            )}
          </div>
        </details>
      </ContentWrap>
    </section>
  );
}

function EvidenceSlot({
  label,
  value,
  empty,
  mono = false,
}: {
  label: string;
  value: string | null;
  empty: string;
  mono?: boolean;
}) {
  return (
    <div className="px-5 py-4 grid grid-cols-1 gap-2 sm:grid-cols-[120px_1fr] sm:gap-5">
      <p className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
        {label}
      </p>
      <p
        className={
          value === null
            ? "text-sm text-[var(--color-ink-subtle)]"
            : mono
              ? "font-mono text-xs text-[var(--color-ink)] break-words"
              : "text-sm text-[var(--color-ink-muted)] leading-relaxed"
        }
      >
        {value ?? empty}
      </p>
    </div>
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

function evidenceStatus(bundle: PublicEvidenceBundle): EvidenceStatus {
  const count = visibleEvidenceSlotCount(bundle);
  if (count === 3) return "complete";
  if (count > 0) return "partial";
  return "empty";
}

function evidenceBadgeLabel(status: EvidenceStatus): string {
  if (status === "complete") return "evidence complete";
  if (status === "partial") return "evidence partial";
  return "no evidence";
}

function isPublicClosedReceipt(row: PublicReceiptDetailRow): boolean {
  return row.status === "closed" && row.closedAt !== null;
}

function visibleEvidenceSlotCount(bundle: PublicEvidenceBundle): number {
  if (bundle === null) return 0;
  return [
    slotText(bundle.pocSnippet, "text"),
    slotText(bundle.reproductionCommand, "command"),
    callPathLines(bundle.callPathTrace).length > 0 ? "present" : null,
  ].filter((value) => value !== null).length;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function slotText(slot: unknown, key: string): string | null {
  const slotRecord = asRecord(slot);
  const value = asRecord(slotRecord?.["value"]);
  const text = value?.[key];
  return typeof text === "string" && text.trim().length > 0 ? text : null;
}

function callPathLines(slot: unknown): string[] {
  const slotRecord = asRecord(slot);
  const value = asRecord(slotRecord?.["value"]);
  if (value === null) return [];
  const out: string[] = [];
  const entry = asRecord(value["entryPoint"]);
  if (entry !== null) {
    const path = typeof entry["path"] === "string" ? entry["path"] : null;
    const line = typeof entry["line"] === "number" ? entry["line"] : null;
    const kind = typeof entry["kind"] === "string" ? entry["kind"] : "entry";
    if (path !== null) out.push(`${kind}: ${path}${line === null ? "" : `:${line}`}`);
  }
  const callPath = value["callPath"];
  if (Array.isArray(callPath)) {
    for (const hop of callPath) {
      if (typeof hop === "string" && hop.trim().length > 0) out.push(hop);
    }
  }
  return out;
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
