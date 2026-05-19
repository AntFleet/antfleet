// D4: result pages live at /roasts/[id] rather than /agents/[address]
// with a synthetic "roast:<id>" slug. Why: /agents/[address] hard-404s
// (notFound()) when loadAgentDetail returns null, and that's intentional —
// the agent page is by-design "no findings → no page". Roasts ship in
// queued/running/rejected states with zero findings, so reusing the agent
// route would 404 them. Parallel route with focused state machine instead.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadRoastDetail } from "@/db/queries";
import type { AgentFinding, RoastSubmission } from "@/db/schema";
import { renderFindingMarkdown, severityLabel, shortAddress } from "@/lib/agent-findings";
import { formatRelativeTime } from "@/lib/receipts";
import { CopyBadgeSnippet } from "@/app/agents/[address]/CopyBadgeSnippet";

export const dynamic = "force-dynamic";

type RouteParams = { id: string };

const SITE_URL = "https://www.antfleet.dev";
const SEVERITY_RANK: Record<string, number> = { info: 0, low: 1, med: 2, high: 3 };

export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { id } = await params;
  const detail = await loadRoastDetail(id);
  if (detail === null) {
    return { title: "AntFleet · Roast not found" };
  }

  const { submission, findings } = detail;
  const pageUrl = roastPageUrl(submission.id);
  const badgeUrl = roastBadgeUrl(submission.repoFullName);
  const title = metadataTitle(submission);
  const description = metadataDescription(submission, findings);

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: [badgeUrl],
      url: pageUrl,
    },
    twitter: {
      card: "summary",
    },
  };
}

export default async function RoastResultPage({ params }: { params: Promise<RouteParams> }) {
  const { id } = await params;
  const detail = await loadRoastDetail(id);
  if (detail === null) {
    notFound();
  }

  const now = new Date();
  const pageUrl = roastPageUrl(detail.submission.id);
  const badgeUrl = roastBadgeUrl(detail.submission.repoFullName);

  return (
    <>
      <Header submission={detail.submission} findings={detail.findings} now={now} />
      {detail.submission.status === "queued" && (
        <>
          <SectionDivider />
          <QueuedSection submission={detail.submission} now={now} />
        </>
      )}
      {detail.submission.status === "running" && (
        <>
          <SectionDivider />
          <RunningSection submission={detail.submission} now={now} />
        </>
      )}
      {detail.submission.status === "published" && (
        <>
          <SectionDivider />
          <FindingsSection findings={detail.findings} now={now} />
          <SectionDivider />
          <ShareSection submission={detail.submission} pageUrl={pageUrl} badgeUrl={badgeUrl} />
        </>
      )}
      {detail.submission.status === "rejected" && (
        <>
          <SectionDivider />
          <RejectedSection submission={detail.submission} now={now} />
        </>
      )}
      <SectionDivider />
      <FooterLink />
    </>
  );
}

function Header({
  submission,
  findings,
  now,
}: {
  submission: RoastSubmission;
  findings: AgentFinding[];
  now: Date;
}) {
  const status = submission.status;
  const relative =
    status === "published" && submission.publishedAt !== null
      ? formatRelativeTime(now, submission.publishedAt)
      : formatRelativeTime(now, submission.createdAt);
  const highestSeverity = pickHighestSeverity(findings);

  return (
    <section className="py-20 pb-12">
      <ContentWrap>
        <p className="mb-6 font-mono text-xs uppercase tracking-widest text-[var(--color-ink-subtle)]">
          Roast · {shortAddress(`roast:${submission.id}`)}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug">
          <a
            href={submission.repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 decoration-[var(--color-line-strong)] transition-colors hover:text-[var(--color-ink-muted)]"
          >
            {submission.repoFullName}
          </a>
        </h1>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Badge>{statusLine(status, relative)}</Badge>
          {status === "published" && (
            <>
              <Badge>{`${findings.length} finding${findings.length === 1 ? "" : "s"}`}</Badge>
              {highestSeverity !== null && (
                <Badge>top severity: {severityLabel(highestSeverity)}</Badge>
              )}
            </>
          )}
        </div>
      </ContentWrap>
    </section>
  );
}

function QueuedSection({ submission, now }: { submission: RoastSubmission; now: Date }) {
  const relative = formatRelativeTime(now, submission.createdAt);
  return (
    <section>
      <ContentWrap>
        <h2 className="mb-5 text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
          Roast
        </h2>
        <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed">
          Queued · submitted {relative}
        </p>
        <p className="mt-4 max-w-xl text-sm leading-relaxed text-[var(--color-ink-muted)]">
          We publish one roast every 24h. You&apos;ll see findings appear here when this one runs.
        </p>
        <p className="mt-3 font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
          ETA: within 24h of submission.
        </p>
      </ContentWrap>
    </section>
  );
}

function RunningSection({ submission, now }: { submission: RoastSubmission; now: Date }) {
  const relative = formatRelativeTime(now, submission.createdAt);
  return (
    <section>
      <ContentWrap>
        <h2 className="mb-5 text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
          Roast
        </h2>
        <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed">
          Running · started {relative}
        </p>
        <p className="mt-4 max-w-xl text-sm leading-relaxed text-[var(--color-ink-muted)]">
          Two frontier models are reading the repo. Findings appear here when the run completes.
        </p>
      </ContentWrap>
    </section>
  );
}

function RejectedSection({ submission, now }: { submission: RoastSubmission; now: Date }) {
  const relative = formatRelativeTime(now, submission.createdAt);
  return (
    <section>
      <ContentWrap>
        <h2 className="mb-5 text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
          Roast
        </h2>
        <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed">
          Rejected · {relative}
        </p>
        <p className="mt-4 max-w-xl text-sm leading-relaxed text-[var(--color-ink-muted)]">
          {submission.rejectionReason?.trim() || "Submission did not meet roast criteria."}
        </p>
      </ContentWrap>
    </section>
  );
}

function FindingsSection({ findings, now }: { findings: AgentFinding[]; now: Date }) {
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
          Findings
        </h2>
        <div className="flex flex-col gap-12">
          {findings.map((f) => (
            <FindingBlock key={f.findingId} finding={f} now={now} />
          ))}
        </div>
      </ContentWrap>
    </section>
  );
}

function FindingBlock({ finding, now }: { finding: AgentFinding; now: Date }) {
  const relative = formatRelativeTime(now, finding.publishedAt);
  const upstreamLabel =
    finding.upstreamMergedSha !== null
      ? `merged ${finding.upstreamMergedSha.slice(0, 7)}`
      : finding.upstreamPrUrl !== null
        ? "upstream PR"
        : null;

  return (
    <article className="border-l-2 border-[var(--color-line-strong)] pl-5">
      <p className="font-mono text-[11px] text-[var(--color-ink-subtle)] tracking-widest uppercase">
        {finding.findingId}
      </p>
      <h3 className="text-xl font-semibold text-[var(--color-ink)] leading-snug mt-2">
        {finding.title}
      </h3>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge>{severityLabel(finding.severity)}</Badge>
        <Badge>{relative}</Badge>
        {finding.upstreamPrUrl !== null && (
          <a
            href={finding.upstreamPrUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-[var(--color-line-strong)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] hover:underline underline-offset-2 transition-colors"
          >
            {upstreamLabel} ↗
          </a>
        )}
      </div>

      <div className="mt-6 max-w-2xl">{renderFindingMarkdown(finding.summary)}</div>

      {finding.evidence !== null && finding.evidence.trim() !== "" && (
        <div className="mt-6 max-w-2xl">
          <h4 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-3">
            Evidence
          </h4>
          {renderFindingMarkdown(finding.evidence)}
        </div>
      )}
    </article>
  );
}

function ShareSection({
  submission,
  pageUrl,
  badgeUrl,
}: {
  submission: RoastSubmission;
  pageUrl: string;
  badgeUrl: string;
}) {
  const snippet = `[![AntFleet roast: ${submission.repoFullName}](${badgeUrl})](${pageUrl})`;
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
          Share
        </h2>
        <CopyBadgeSnippet snippet={snippet} badgeUrl={badgeUrl} />
        <p className="mt-4 break-all font-mono text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
          {badgeUrl}
        </p>
      </ContentWrap>
    </section>
  );
}

function FooterLink() {
  return (
    <section className="pb-20">
      <ContentWrap>
        <a
          href="/roast"
          className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)] underline underline-offset-4 transition-colors hover:text-[var(--color-ink)]"
        >
          Submit another roast →
        </a>
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

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
      {children}
    </span>
  );
}

function roastPageUrl(id: string): string {
  return `${SITE_URL}/roasts/${encodeURIComponent(id)}`;
}

function roastBadgeUrl(repoFullName: string): string {
  return `${SITE_URL}/badge/${repoFullName}.svg`;
}

function metadataTitle(submission: RoastSubmission): string {
  if (submission.status === "rejected") {
    return `AntFleet roast (rejected): ${submission.repoFullName}`;
  }
  if (submission.status === "queued" || submission.status === "running") {
    return `AntFleet roast (in progress): ${submission.repoFullName}`;
  }
  return `AntFleet roast: ${submission.repoFullName}`;
}

function metadataDescription(submission: RoastSubmission, findings: AgentFinding[]): string {
  if (submission.status === "published") {
    return findings[0]?.title ?? "Published roast findings.";
  }
  if (submission.status === "queued") return "In the queue.";
  if (submission.status === "running") return "Running now.";
  if (submission.status === "rejected") {
    const reason = submission.rejectionReason?.trim() || "Submission did not meet roast criteria.";
    return `Rejected: ${truncate(reason, 120)}`;
  }
  return "Roast status pending.";
}

function statusLine(status: string, relative: string): string {
  if (status === "queued") return `Queued · submitted ${relative}`;
  if (status === "running") return `Running · started ${relative}`;
  if (status === "published") return `Published ${relative}`;
  if (status === "rejected") return `Rejected · ${relative}`;
  return status;
}

function pickHighestSeverity(findings: AgentFinding[]): string | null {
  let best: string | null = null;
  let bestRank = -1;
  for (const finding of findings) {
    const rank = SEVERITY_RANK[finding.severity] ?? -1;
    if (rank > bestRank) {
      best = finding.severity;
      bestRank = rank;
    }
  }
  return best;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
