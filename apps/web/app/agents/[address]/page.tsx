import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  loadAgentDetail,
  type AgentBenchmarkReference,
  type AgentCrossRepoMerge,
} from "@/db/queries";
import type { AgentFinding } from "@/db/schema";
import { findAgentByAddress } from "@/lib/agent-registry";
import { formatRelativeTime } from "@/lib/receipts";
import { renderFindingMarkdown, severityLabel, shortAddress } from "@/lib/agent-findings";
import { CopyBadgeSnippet } from "./CopyBadgeSnippet";

// Per-agent finding page. Reads agent_findings WHERE lower(address) = lower
// (slug) and renders every finding inline (info → high), most recent first.
// Also lists any benchmark reviews that target the agent's `-bench` repo
// (cross-reference under "Reviews on this agent").
//
// 404 when no findings exist for the address — we intentionally don't
// surface an "agent" the way GitHub surfaces an empty user; the page only
// has meaning when there's investigative content on file.
export const dynamic = "force-dynamic";

type RouteParams = { address: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { address } = await params;
  const detail = await loadAgentDetail(address);
  if (detail === null) {
    return { title: "AntFleet · Agent not found" };
  }
  const first = detail.findings[0]!;
  return {
    title: `AntFleet · ${detail.agentName}`,
    description: first.title,
  };
}

export default async function AgentDetailPage({ params }: { params: Promise<RouteParams> }) {
  const { address } = await params;
  const detail = await loadAgentDetail(address);
  if (detail === null) {
    notFound();
  }
  const now = new Date();
  const registryEntry = findAgentByAddress(address);

  return (
    <>
      <Header detail={detail} now={now} />
      {registryEntry !== null && (
        <>
          <SectionDivider />
          <BadgeEmbedSection repo={registryEntry.repo} />
        </>
      )}
      {detail.crossRepoMerges.length > 0 && (
        <>
          <SectionDivider />
          <CrossRepoMergesSection merges={detail.crossRepoMerges} now={now} />
        </>
      )}
      <SectionDivider />
      <FindingsSection findings={detail.findings} now={now} />
      {detail.benchmarkReviews.length > 0 && (
        <>
          <SectionDivider />
          <BenchmarksSection reviews={detail.benchmarkReviews} now={now} />
        </>
      )}
    </>
  );
}

function BadgeEmbedSection({ repo }: { repo: string }) {
  const badgeUrl = `https://www.antfleet.dev/badge/${repo}.svg`;
  const snippet = `[![AntFleet findings](${badgeUrl})](https://www.antfleet.dev/agents/0xB3D7e0c3C39A1D3F1B304663065A2F83Ddf56d8e)`;
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
          Badge
        </h2>
        <CopyBadgeSnippet snippet={snippet} />
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
  now,
}: {
  detail: {
    agentName: string;
    agentTokenAddress: string;
    findings: AgentFinding[];
    crossRepoMerges: AgentCrossRepoMerge[];
  };
  now: Date;
}) {
  const findingCount = detail.findings.length;
  const lastFinding = detail.findings[0]!;
  const relative = formatRelativeTime(now, lastFinding.publishedAt);
  const hasOpenPr = detail.findings.some(
    (f) => f.upstreamPrUrl !== null && f.upstreamMergedSha === null,
  );
  const hasMergedPr = detail.findings.some((f) => f.upstreamMergedSha !== null);
  const upstreamMergeCount = detail.crossRepoMerges.length;

  return (
    <section className="py-20 pb-12">
      <ContentWrap>
        <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
          Agent investigation · {shortAddress(detail.agentTokenAddress)}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug">
          {detail.agentName}
        </h1>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Badge>{`${findingCount} finding${findingCount === 1 ? "" : "s"}`}</Badge>
          {upstreamMergeCount > 0 && (
            <Badge>{`${upstreamMergeCount} merge${upstreamMergeCount === 1 ? "" : "s"} upstream`}</Badge>
          )}
          {hasMergedPr && <Badge>upstream merged</Badge>}
          {hasOpenPr && !hasMergedPr && <Badge>upstream PR open</Badge>}
          <Badge>updated {relative}</Badge>
        </div>
        <div className="mt-6 font-mono text-[11px] text-[var(--color-ink-subtle)] flex flex-wrap items-center gap-x-3 gap-y-1 break-all">
          <span>token</span>
          <span className="text-[var(--color-ink)]">{detail.agentTokenAddress}</span>
          <a
            href={`https://basescan.org/address/${detail.agentTokenAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-[var(--color-ink)] transition-colors"
          >
            basescan ↗
          </a>
        </div>
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

function CrossRepoMergesSection({ merges, now }: { merges: AgentCrossRepoMerge[]; now: Date }) {
  return (
    <section>
      <ContentWrap>
        <div className="mb-5 flex items-baseline justify-between">
          <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
            Upstream merges
          </h2>
          <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
            {merges.length} {merges.length === 1 ? "merge" : "merges"} on this agent
          </span>
        </div>
        <p className="text-sm text-[var(--color-ink-muted)] mb-6 max-w-xl leading-relaxed">
          PRs AntFleet opened against this agent&apos;s own repo and the upstream owner merged. The
          highest-trust attribution class — the maintainer of a project AntFleet doesn&apos;t
          control accepted the change.
        </p>
        <ul className="flex flex-col divide-y divide-[var(--color-line)] border-t border-b border-[var(--color-line)]">
          {merges.map((m) => (
            <li key={m.id}>
              <CrossRepoMergeRow merge={m} now={now} />
            </li>
          ))}
        </ul>
      </ContentWrap>
    </section>
  );
}

function CrossRepoMergeRow({ merge, now }: { merge: AgentCrossRepoMerge; now: Date }) {
  const arrowLabel = `AntFleet → ${merge.upstreamOwner.toLowerCase()}/${merge.upstreamRepo.toLowerCase()}`;
  const shortSha = merge.mergeSha.slice(0, 7);
  return (
    <a
      href={merge.prUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex flex-col gap-3 py-5 sm:flex-row sm:items-start sm:gap-6 group transition-colors hover:bg-[var(--color-bg-elevated)] -mx-3 px-3 rounded-md"
    >
      <div className="flex flex-wrap items-center gap-2 sm:w-44 sm:shrink-0">
        <Badge>cross-repo</Badge>
        <Badge>merged</Badge>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[var(--color-ink)] leading-snug group-hover:underline underline-offset-2 font-mono">
          {arrowLabel}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
          <span>PR #{merge.upstreamPrNumber}</span>
          <span className="text-[var(--color-line-strong)]">·</span>
          <span>
            merged at <span className="text-[var(--color-ink-muted)]">{shortSha}</span>
          </span>
          <span className="text-[var(--color-line-strong)]">·</span>
          <span>{formatRelativeTime(now, merge.mergedAt)}</span>
        </div>
      </div>
      <span className="font-mono text-[11px] text-[var(--color-ink-subtle)] group-hover:text-[var(--color-ink)] transition-colors sm:shrink-0 sm:self-center">
        view PR →
      </span>
    </a>
  );
}

function BenchmarksSection({ reviews, now }: { reviews: AgentBenchmarkReference[]; now: Date }) {
  return (
    <section className="pb-20">
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
          AntFleet reviews on this agent
        </h2>
        <p className="text-sm text-[var(--color-ink-muted)] mb-6 max-w-xl leading-relaxed">
          Two-model consensus reviews AntFleet has run against this agent&apos;s benchmark repo.
          Each links to the bot review comment on GitHub.
        </p>
        <ul className="flex flex-col divide-y divide-[var(--color-line)] border-t border-b border-[var(--color-line)]">
          {reviews.map((r) => (
            <li key={r.reviewId}>
              <BenchmarkRow row={r} now={now} />
            </li>
          ))}
        </ul>
      </ContentWrap>
    </section>
  );
}

function BenchmarkRow({ row, now }: { row: AgentBenchmarkReference; now: Date }) {
  const ownerRepo = row.owner !== null && row.repo !== null ? `${row.owner}/${row.repo}` : null;
  const prUrl = ownerRepo === null ? null : `https://github.com/${ownerRepo}/pull/${row.prNumber}`;
  const href = row.prCommentUrl ?? prUrl;
  const relative = formatRelativeTime(now, row.createdAt);

  const content = (
    <div className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:gap-6 group">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[var(--color-ink)] leading-snug group-hover:underline underline-offset-2">
          {ownerRepo ?? `review ${row.reviewId.slice(0, 8)}`} · PR #{row.prNumber}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
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

  if (href === null) {
    return <div className="-mx-3 px-3 rounded-md transition-colors">{content}</div>;
  }
  return (
    <a
      href={href}
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
