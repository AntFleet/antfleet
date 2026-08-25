import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  loadAgentDetail,
  loadFactoryLaunchDetail,
  type AgentBenchmarkReference,
  type AgentCrossRepoMerge,
  type AgentThreatModelReference,
  type FactoryLaunchAgentDetail,
} from "@/db/queries";
import type { AgentFinding } from "@/db/schema";
import { findAgentByAddress } from "@/lib/agent-registry";
import {
  isLandedAgentSubmission,
  loadAgentSubmissions,
  type AgentSubmission,
} from "@/lib/agent-submissions";
import { formatRelativeTime } from "@/lib/receipts";
import { renderFindingMarkdown, severityLabel, shortAddress } from "@/lib/agent-findings";
import { CopyBadgeSnippet } from "./CopyBadgeSnippet";
import { CyberTierBadge } from "./CyberTierBadge";
import { TweetIntent } from "@/components/TweetIntent";
import { SarifIntegrationPanel } from "./SarifIntegrationPanel";
import { loadCyberTierFullNameSet } from "@/lib/cyber-tier";

const SITE_URL = "https://www.antfleet.dev";

type AgentUpstreamFix = {
  id: string;
  upstreamOwner: string;
  upstreamRepo: string;
  upstreamPrNumber: number;
  title: string | null;
  resolvedAt: Date;
  resolutionSha: string;
  closureMethod: string;
  prUrl: string;
  resolutionUrl: string | null;
  channel: AgentSubmission["channel"] | null;
};

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
  if (detail !== null) {
    const first = detail.findings[0]!;
    return {
      title: `AntFleet · ${detail.agentName}`,
      description: first.title,
    };
  }
  const stub = await loadFactoryLaunchDetail(address);
  if (stub !== null) {
    return {
      title: `AntFleet · ${stub.agentName}`,
      description: `Liquid Protocol agent detected on Base — pre-launch verdict pending.`,
    };
  }
  return { title: "AntFleet · Agent not found" };
}

export default async function AgentDetailPage({ params }: { params: Promise<RouteParams> }) {
  const { address } = await params;
  const detail = await loadAgentDetail(address);
  const now = new Date();

  if (detail === null) {
    // Auto-stub from factory_launches — page exists the moment the factory
    // deploys, even before any benchmark publishes. See db/queries.ts §
    // FactoryLaunchAgentDetail.
    const stub = await loadFactoryLaunchDetail(address);
    if (stub === null) notFound();
    return <FactoryLaunchStubPage stub={stub} now={now} />;
  }

  const registryEntryCandidate = findAgentByAddress(address);
  // Cyber-tier exclusion: registry entries and static submissions are
  // ungated data sources. The cyber-aware loadAgentDetail already
  // filters cyber-tier findings, but the registry badge embed,
  // submissions section, public finding count, latest activity, and
  // SARIF repo list would otherwise re-introduce the cyber repo's
  // identifier here. Filter both sources by isCyberTierRepo before
  // they're used anywhere on the page. (Security audit pass-6,
  // severity high, agent-page-information-disclosure.) Uses the
  // batched loadCyberTierFullNameSet to do ONE repo_tier query per
  // render instead of N — addresses architect pass-7 medium
  // n+1 lookups.
  const submissionsAll = loadAgentSubmissions(detail.agentTokenAddress);
  const cyberFullNames = await loadCyberTierFullNameSet([
    ...submissionsAll.map((s) => s.repoFullName),
    ...(registryEntryCandidate?.repo !== undefined && registryEntryCandidate.repo !== null
      ? [registryEntryCandidate.repo]
      : []),
  ]);
  const submissions: AgentSubmission[] = submissionsAll.filter(
    (s) => !cyberFullNames.has(s.repoFullName.toLowerCase()),
  );
  const registryEntry =
    registryEntryCandidate !== null &&
    registryEntryCandidate.repo !== null &&
    cyberFullNames.has(registryEntryCandidate.repo.toLowerCase())
      ? null
      : registryEntryCandidate;
  const publicFindingCount = Math.max(detail.findings.length, submissions.length);
  const latestActivityAt = latestAgentActivityAt(detail.findings, submissions);
  const upstreamFixes = agentUpstreamFixes(detail.crossRepoMerges, submissions);
  const repos = agentRepos(detail.findings, submissions);

  return (
    <>
      <Header
        detail={detail}
        now={now}
        publicFindingCount={publicFindingCount}
        latestActivityAt={latestActivityAt}
        upstreamFixCount={upstreamFixes.length}
        hasCyberTierRepo={detail.hasCyberTierRepo}
      />
      {registryEntry !== null && (
        <>
          <SectionDivider />
          <BadgeEmbedSection repo={registryEntry.repo} address={address} />
        </>
      )}
      {submissions.length > 0 && (
        <>
          <SectionDivider />
          <AgentSubmissionsSection submissions={submissions} now={now} />
        </>
      )}
      {upstreamFixes.length > 0 && (
        <>
          <SectionDivider />
          <CrossRepoMergesSection fixes={upstreamFixes} now={now} />
        </>
      )}
      {detail.threatModels.length > 0 && (
        <>
          <SectionDivider />
          <ThreatModelsSection models={detail.threatModels} />
        </>
      )}
      <SectionDivider />
      <SarifSection repos={repos} />
      <SectionDivider />
      <FindingsSection
        findings={detail.findings}
        submissionCount={submissions.length}
        publicFindingCount={publicFindingCount}
        now={now}
      />
      {detail.benchmarkReviews.length > 0 && (
        <>
          <SectionDivider />
          <BenchmarksSection reviews={detail.benchmarkReviews} now={now} />
        </>
      )}
    </>
  );
}

function SarifSection({ repos }: { repos: string[] }) {
  return (
    <section>
      <ContentWrap>
        <div className="mb-5 flex items-baseline justify-between gap-4">
          <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
            SARIF backlog
          </h2>
          <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
            CodeQL · Snyk · Semgrep
          </span>
        </div>
        <p className="mb-5 max-w-xl text-sm leading-relaxed text-[var(--color-ink-muted)]">
          Validate scanner backlog claims through AntFleet&apos;s reachability and
          patch-verification gates, and emit AntFleet findings as SARIF v2.1.0 for GitHub Code
          Scanning.
        </p>
        <SarifIntegrationPanel repos={repos} />
      </ContentWrap>
    </section>
  );
}

function FactoryLaunchStubPage({ stub, now }: { stub: FactoryLaunchAgentDetail; now: Date }) {
  const { launch, agentName, agentTokenAddress } = stub;
  const deployRelative = formatRelativeTime(now, launch.deployedAt);
  const repoUrl = launch.repoFullName !== null ? `https://github.com/${launch.repoFullName}` : null;
  const statusLabel = (() => {
    switch (launch.prelaunchStatus) {
      case "pending":
        return "looking for repo";
      case "benchmarking":
        return "benchmarking";
      case "published":
        return "pre-launch verdict published";
      case "repo_not_found":
        return "repo not found";
      case "benchmark_failed":
        return "benchmark failed";
      default:
        return launch.prelaunchStatus;
    }
  })();

  return (
    <section className="py-20 pb-20">
      <ContentWrap>
        <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
          Liquid Protocol agent · {shortAddress(agentTokenAddress)}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug">
          {agentName}
          {launch.tokenName !== null &&
            launch.tokenSymbol !== null &&
            launch.tokenName !== launch.tokenSymbol && (
              <span className="ml-3 font-mono text-base text-[var(--color-ink-muted)]">
                ({launch.tokenName})
              </span>
            )}
        </h1>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Badge>auto-stub</Badge>
          <Badge>{statusLabel}</Badge>
          <Badge>deployed {deployRelative}</Badge>
        </div>
        <div className="mt-6 font-mono text-[11px] text-[var(--color-ink-subtle)] flex flex-wrap items-center gap-x-3 gap-y-1 break-all">
          <span>token</span>
          <span className="text-[var(--color-ink)]">{agentTokenAddress}</span>
          <a
            href={`https://basescan.org/address/${agentTokenAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-[var(--color-ink)] transition-colors"
          >
            basescan ↗
          </a>
        </div>
        <div className="mt-1 font-mono text-[11px] text-[var(--color-ink-subtle)] flex flex-wrap items-center gap-x-3 gap-y-1 break-all">
          <span>deployer</span>
          <span className="text-[var(--color-ink)]">{launch.deployerAddress}</span>
        </div>
        {repoUrl !== null && (
          <div className="mt-1 font-mono text-[11px] text-[var(--color-ink-subtle)] flex flex-wrap items-center gap-x-3 gap-y-1 break-all">
            <span>repo</span>
            <a
              href={repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--color-ink)] underline underline-offset-2 hover:opacity-80 transition-opacity"
            >
              {launch.repoFullName}
            </a>
          </div>
        )}
        {launch.repoFullName === null && launch.prelaunchStatus === "repo_not_found" && (
          <UnclaimedBanner address={agentTokenAddress} />
        )}
        <p className="mt-10 text-sm text-[var(--color-ink-muted)] max-w-xl leading-relaxed">
          AntFleet detected this agent the moment its factory transaction confirmed on Base. No
          investigative findings have been filed yet — the row will populate here once the
          pre-launch benchmark runs or an operator publishes the first finding.
        </p>
      </ContentWrap>
    </section>
  );
}

function UnclaimedBanner({ address }: { address: string }) {
  return (
    <div className="mt-8 max-w-xl rounded-md border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] p-5">
      <p className="text-sm leading-relaxed text-[var(--color-ink)]">
        AntFleet couldn&apos;t find this agent&apos;s source repo. Are you the deployer?
      </p>
      <p className="mt-2 text-sm leading-relaxed text-[var(--color-ink-muted)]">
        Sign a message with the deployer wallet to attribute a GitHub repo. The page populates here
        once the pre-launch benchmark runs against your repo.
      </p>
      <a
        href={`/agents/${address}/claim`}
        className="mt-4 inline-block rounded-md border border-[var(--color-line-strong)] px-3 py-1.5 font-mono text-[11px] text-[var(--color-ink)] hover:bg-white transition-colors"
      >
        Claim this agent →
      </a>
    </div>
  );
}

function AgentSubmissionsSection({
  submissions,
  now,
}: {
  submissions: AgentSubmission[];
  now: Date;
}) {
  const prCount = submissions.filter((submission) => submission.kind === "pr").length;
  const issueCount = submissions.filter((submission) => submission.kind === "issue").length;
  const openCount = submissions.filter((submission) => submission.status === "open").length;
  const landedCount = submissions.filter((submission) => submission.status !== "open").length;

  return (
    <section>
      <ContentWrap>
        <div className="mb-5 flex items-baseline justify-between gap-4">
          <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
            AntFleet submissions
          </h2>
          <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
            {prCount} PRs · {issueCount} issues
          </span>
        </div>
        <p className="text-sm text-[var(--color-ink-muted)] mb-6 max-w-xl leading-relaxed">
          PRs and issues submitted by <span className="font-mono">antfleet-ops</span> against this
          agent&apos;s upstream repo. Every row is AntFleet work, whether it originated from the app
          pipeline or an operator-assisted review loop.
        </p>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Badge>{openCount} open</Badge>
          <Badge>{landedCount} landed or resolved</Badge>
        </div>
        <ul className="flex flex-col divide-y divide-[var(--color-line)] border-t border-b border-[var(--color-line)]">
          {submissions.map((submission) => (
            <li key={`${submission.kind}-${submission.number}`}>
              <AgentSubmissionRow submission={submission} now={now} />
            </li>
          ))}
        </ul>
      </ContentWrap>
    </section>
  );
}

function AgentSubmissionRow({ submission, now }: { submission: AgentSubmission; now: Date }) {
  const submittedRelative = formatRelativeTime(now, new Date(submission.submittedAt));
  const resolvedRelative =
    submission.resolvedAt !== null
      ? formatRelativeTime(now, new Date(submission.resolvedAt))
      : null;
  const shortSha = submission.resolutionSha !== null ? submission.resolutionSha.slice(0, 7) : null;
  const channelLabel =
    submission.channel === "direct_claude_code" ? "operator-assisted AntFleet" : "AntFleet app";
  const statusLabel = (() => {
    switch (submission.status) {
      case "open":
        return "open";
      case "merged":
        return "merged";
      case "absorbed":
        return "fix absorbed";
      case "superseded_landed":
        return "superseded, landed";
    }
  })();

  return (
    <article className="py-5 -mx-3 px-3 rounded-md transition-colors hover:bg-[var(--color-bg-elevated)]">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-6">
        <div className="flex flex-wrap items-center gap-2 sm:w-44 sm:shrink-0">
          <Badge>{statusLabel}</Badge>
          <Badge>
            {submission.kind.toUpperCase()} #{submission.number}
          </Badge>
        </div>
        <div className="flex-1 min-w-0">
          <a
            href={submission.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-[var(--color-ink)] leading-snug hover:underline underline-offset-2"
          >
            {submission.title} ↗
          </a>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
            <span>{channelLabel}</span>
            <span className="text-[var(--color-line-strong)]">·</span>
            <span>opened {submittedRelative}</span>
            {resolvedRelative !== null && (
              <>
                <span className="text-[var(--color-line-strong)]">·</span>
                <span>resolved {resolvedRelative}</span>
              </>
            )}
            {shortSha !== null && (
              <>
                <span className="text-[var(--color-line-strong)]">·</span>
                {submission.resolutionUrl !== null ? (
                  <a
                    href={submission.resolutionUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] hover:underline underline-offset-2"
                  >
                    {shortSha} ↗
                  </a>
                ) : (
                  <span className="text-[var(--color-ink-muted)]">{shortSha}</span>
                )}
              </>
            )}
          </div>
          {submission.note !== null && (
            <p className="mt-2 text-sm leading-relaxed text-[var(--color-ink-muted)]">
              {submission.note}
            </p>
          )}
        </div>
      </div>
    </article>
  );
}

function BadgeEmbedSection({ repo, address }: { repo: string; address: string }) {
  const badgeUrl = `https://www.antfleet.dev/badge/${repo}.svg`;
  const snippet = `[![AntFleet findings](${badgeUrl})](https://www.antfleet.dev/agents/${address})`;
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
          Badge
        </h2>
        <CopyBadgeSnippet snippet={snippet} badgeUrl={badgeUrl} />
      </ContentWrap>
    </section>
  );
}

type PublicThreatModelItem = {
  name?: unknown;
  kind?: unknown;
  path?: unknown;
  line?: unknown;
  summary?: unknown;
  confidence?: unknown;
};

type PublicThreatModelSection = {
  items?: unknown;
};

function ThreatModelsSection({ models }: { models: AgentThreatModelReference[] }) {
  return (
    <section>
      <ContentWrap>
        <div className="mb-5 flex items-baseline justify-between gap-4">
          <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
            Attack surface
          </h2>
          <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
            {models.length} repo{models.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex flex-col divide-y divide-[var(--color-line)] border-t border-b border-[var(--color-line)]">
          {models.map((model) => (
            <ThreatModelBlock key={`${model.owner}/${model.repo}`} model={model} />
          ))}
        </div>
      </ContentWrap>
    </section>
  );
}

function ThreatModelBlock({ model }: { model: AgentThreatModelReference }) {
  const view = asThreatModelView(model.publicModel);
  if (view === null) return null;
  const shortSha = model.lastReviewedSha.slice(0, 7);
  return (
    <details className="group py-5">
      <summary className="cursor-pointer list-none">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-medium text-[var(--color-ink)]">
              {model.owner}/{model.repo}
            </h3>
            <p className="mt-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
              reviewed {shortSha}
            </p>
          </div>
          <span className="font-mono text-[11px] text-[var(--color-ink-muted)] group-open:hidden">
            expand
          </span>
          <span className="hidden font-mono text-[11px] text-[var(--color-ink-muted)] group-open:inline">
            collapse
          </span>
        </div>
      </summary>
      <div className="mt-5 grid gap-5">
        <ThreatModelSectionList title="Entry points" items={view.entryPoints} />
        <ThreatModelSectionList title="Trust boundaries" items={view.trustBoundaries} />
        <ThreatModelSectionList title="Sinks" items={view.sinks} />
      </div>
    </details>
  );
}

function ThreatModelSectionList({
  title,
  items,
}: {
  title: string;
  items: PublicThreatModelItem[];
}) {
  return (
    <div>
      <h4 className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
        {title}
      </h4>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--color-ink-muted)]">No public entries recorded.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {items.map((item, index) => (
            <li key={`${String(item.path)}-${String(item.line)}-${index}`} className="text-sm">
              <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
                {safeText(item.kind)}
              </span>{" "}
              <span className="text-[var(--color-ink)]">{safeText(item.path)}</span>
              {typeof item.line === "number" && (
                <span className="text-[var(--color-ink-subtle)]">:{item.line}</span>
              )}
              <span className="text-[var(--color-ink-muted)]"> - {safeText(item.summary)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function asThreatModelView(value: unknown): {
  entryPoints: PublicThreatModelItem[];
  trustBoundaries: PublicThreatModelItem[];
  sinks: PublicThreatModelItem[];
} | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const sections = (value as { sections?: unknown }).sections;
  if (sections === null || typeof sections !== "object" || Array.isArray(sections)) return null;
  const record = sections as Record<string, PublicThreatModelSection>;
  return {
    entryPoints: sectionItems(record["entryPoints"]),
    trustBoundaries: sectionItems(record["trustBoundaries"]),
    sinks: sectionItems(record["sinks"]),
  };
}

function sectionItems(section: PublicThreatModelSection | undefined): PublicThreatModelItem[] {
  if (section === undefined || !Array.isArray(section.items)) return [];
  return section.items.filter(
    (item): item is PublicThreatModelItem =>
      item !== null && typeof item === "object" && !Array.isArray(item),
  );
}

function safeText(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

function latestAgentActivityAt(findings: AgentFinding[], submissions: AgentSubmission[]): Date {
  const timestamps = [
    ...findings.map((finding) => finding.publishedAt),
    ...submissions.map((submission) => new Date(submission.submittedAt)),
  ];
  return timestamps.reduce((latest, current) => (current > latest ? current : latest));
}

function agentUpstreamFixes(
  merges: AgentCrossRepoMerge[],
  submissions: AgentSubmission[],
): AgentUpstreamFix[] {
  const fixes = new Map<string, AgentUpstreamFix>();

  for (const submission of submissions) {
    if (
      submission.kind !== "pr" ||
      !isLandedAgentSubmission(submission) ||
      submission.resolvedAt === null ||
      submission.resolutionSha === null
    ) {
      continue;
    }
    const repo = parseRepoFullName(submission.repoFullName);
    if (repo === null) continue;
    fixes.set(`${submission.repoFullName.toLowerCase()}#${submission.number}`, {
      id: `submission-${submission.repoFullName}-${submission.number}`,
      upstreamOwner: repo.owner,
      upstreamRepo: repo.repo,
      upstreamPrNumber: submission.number,
      title: submission.title,
      resolvedAt: new Date(submission.resolvedAt),
      resolutionSha: submission.resolutionSha,
      closureMethod: closureMethodForSubmission(submission),
      prUrl: submission.url,
      resolutionUrl: submission.resolutionUrl,
      channel: submission.channel,
    });
  }

  for (const merge of merges) {
    const key =
      `${merge.upstreamOwner}/${merge.upstreamRepo}#${merge.upstreamPrNumber}`.toLowerCase();
    if (fixes.has(key)) continue;
    fixes.set(key, {
      id: merge.id,
      upstreamOwner: merge.upstreamOwner,
      upstreamRepo: merge.upstreamRepo,
      upstreamPrNumber: merge.upstreamPrNumber,
      title: null,
      resolvedAt: merge.resolvedAt,
      resolutionSha: merge.resolutionSha,
      closureMethod: merge.closureMethod,
      prUrl: merge.prUrl,
      resolutionUrl: null,
      channel: null,
    });
  }

  return [...fixes.values()].toSorted((a, b) => b.resolvedAt.getTime() - a.resolvedAt.getTime());
}

function parseRepoFullName(repoFullName: string): { owner: string; repo: string } | null {
  const [owner, repo] = repoFullName.split("/");
  if (owner === undefined || repo === undefined || owner === "" || repo === "") return null;
  return { owner, repo };
}

function agentRepos(findings: AgentFinding[], submissions: AgentSubmission[]): string[] {
  return [
    ...new Set(
      [
        ...findings.map((finding) => finding.repoFullName),
        ...submissions.map((submission) => submission.repoFullName),
      ].filter((repo): repo is string => repo !== null && repo.includes("/")),
    ),
  ].toSorted();
}

function closureMethodForSubmission(submission: AgentSubmission): string {
  switch (submission.status) {
    case "absorbed":
      return "absorbed_inline";
    case "superseded_landed":
      return "superseded_landed";
    case "merged":
      return "merged";
    case "open":
      return "open";
  }
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
  publicFindingCount,
  latestActivityAt,
  upstreamFixCount,
  hasCyberTierRepo,
}: {
  detail: {
    agentName: string;
    agentTokenAddress: string;
    findings: AgentFinding[];
    crossRepoMerges: AgentCrossRepoMerge[];
  };
  now: Date;
  publicFindingCount: number;
  latestActivityAt: Date;
  upstreamFixCount: number;
  hasCyberTierRepo: boolean;
}) {
  const relative = formatRelativeTime(now, latestActivityAt);
  const hasOpenPr = detail.findings.some(
    (f) => f.upstreamPrUrl !== null && f.upstreamMergedSha === null,
  );
  const hasMergedPr =
    upstreamFixCount > 0 || detail.findings.some((f) => f.upstreamMergedSha !== null);

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
          <Badge>{`${publicFindingCount} finding${publicFindingCount === 1 ? "" : "s"}`}</Badge>
          {upstreamFixCount > 0 && (
            <Badge>{`${upstreamFixCount} upstream fix${upstreamFixCount === 1 ? "" : "es"}`}</Badge>
          )}
          {hasMergedPr && <Badge>upstream merged</Badge>}
          {hasOpenPr && !hasMergedPr && <Badge>upstream PR open</Badge>}
          {hasCyberTierRepo && <CyberTierBadge />}
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
          <TweetIntent
            text={`Public investigation on ${detail.agentName} (${shortAddress(detail.agentTokenAddress)}): ${publicFindingCount} finding${publicFindingCount === 1 ? "" : "s"} on file.`}
            url={`${SITE_URL}/agents/${detail.agentTokenAddress}`}
            ariaLabel={`Tweet this agent's findings: ${detail.agentName}`}
            className="underline underline-offset-2 hover:text-[var(--color-ink)] transition-colors"
          >
            tweet ↗
          </TweetIntent>
        </div>
        {(() => {
          const repos = Array.from(
            new Set(
              detail.findings.map((f) => f.repoFullName).filter((r): r is string => r !== null),
            ),
          );
          if (repos.length === 0) return null;
          return (
            <div className="mt-1 font-mono text-[11px] text-[var(--color-ink-subtle)] flex flex-wrap items-center gap-x-3 gap-y-1 break-all">
              <span>repos covered</span>
              {repos.map((repo) => (
                <a
                  key={repo}
                  href={`https://github.com/${repo}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--color-ink)] underline underline-offset-2 hover:opacity-80 transition-opacity"
                >
                  {repo} ↗
                </a>
              ))}
            </div>
          );
        })()}
      </ContentWrap>
    </section>
  );
}

function FindingsSection({
  findings,
  submissionCount,
  publicFindingCount,
  now,
}: {
  findings: AgentFinding[];
  submissionCount: number;
  publicFindingCount: number;
  now: Date;
}) {
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
          Finding writeups
        </h2>
        {submissionCount > findings.length && (
          <p className="mb-8 max-w-xl text-sm leading-relaxed text-[var(--color-ink-muted)]">
            AntFleet has {publicFindingCount} findings on file for this agent. The long-form
            writeups below are the published investigation bodies; the complete PR-level finding
            ledger is listed above under AntFleet submissions.
          </p>
        )}
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
        {finding.verificationStatus !== null && (
          <Badge>{`verification: ${finding.verificationStatus}${finding.verificationMethod !== null ? ` (${finding.verificationMethod})` : ""}`}</Badge>
        )}
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

function CrossRepoMergesSection({ fixes, now }: { fixes: AgentUpstreamFix[]; now: Date }) {
  return (
    <section>
      <ContentWrap>
        <div className="mb-5 flex items-baseline justify-between">
          <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)]">
            Upstream fixes
          </h2>
          <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
            {fixes.length} {fixes.length === 1 ? "fix" : "fixes"} landed on this agent
          </span>
        </div>
        <p className="text-sm text-[var(--color-ink-muted)] mb-6 max-w-xl leading-relaxed">
          PRs AntFleet filed against this agent&apos;s own repo where the underlying fix landed
          upstream — whether via a clean merge, a separate upstream commit, or an upstream PR that
          ported the same fix.
        </p>
        <ul className="flex flex-col divide-y divide-[var(--color-line)] border-t border-b border-[var(--color-line)]">
          {fixes.map((fix) => (
            <li key={fix.id}>
              <CrossRepoMergeRow fix={fix} now={now} />
            </li>
          ))}
        </ul>
      </ContentWrap>
    </section>
  );
}

function CrossRepoMergeRow({ fix, now }: { fix: AgentUpstreamFix; now: Date }) {
  const arrowLabel = `AntFleet → ${fix.upstreamOwner.toLowerCase()}/${fix.upstreamRepo.toLowerCase()}`;
  const shortSha = fix.resolutionSha.slice(0, 7);
  const isAbsorbed = fix.closureMethod === "absorbed_inline";
  const isSuperseded = fix.closureMethod === "superseded_landed";
  const resolvedLabel = isAbsorbed
    ? "fix absorbed at"
    : isSuperseded
      ? "ported upstream at"
      : "merged at";
  const linkUrl =
    fix.resolutionUrl ??
    (isAbsorbed || isSuperseded
      ? `https://github.com/${fix.upstreamOwner}/${fix.upstreamRepo}/commit/${fix.resolutionSha}`
      : fix.prUrl);
  return (
    <a
      href={linkUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex flex-col gap-3 py-5 sm:flex-row sm:items-start sm:gap-6 group transition-colors hover:bg-[var(--color-bg-elevated)] -mx-3 px-3 rounded-md"
    >
      <div className="flex flex-wrap items-center gap-2 sm:w-44 sm:shrink-0">
        <Badge>{isAbsorbed ? "fix absorbed" : isSuperseded ? "fix ported" : "merged"}</Badge>
        {fix.channel === "direct_claude_code" && <Badge>operator-assisted</Badge>}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[var(--color-ink)] leading-snug group-hover:underline underline-offset-2 font-mono">
          {arrowLabel}
        </p>
        {fix.title !== null && (
          <p className="mt-1 text-sm leading-snug text-[var(--color-ink-muted)]">{fix.title}</p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
          <span>PR #{fix.upstreamPrNumber}</span>
          <span className="text-[var(--color-line-strong)]">·</span>
          <span>
            {resolvedLabel} <span className="text-[var(--color-ink-muted)]">{shortSha}</span>
          </span>
          <span className="text-[var(--color-line-strong)]">·</span>
          <span>{formatRelativeTime(now, fix.resolvedAt)}</span>
        </div>
      </div>
      <span className="font-mono text-[11px] text-[var(--color-ink-subtle)] group-hover:text-[var(--color-ink)] transition-colors sm:shrink-0 sm:self-center">
        {isAbsorbed || isSuperseded ? "view commit →" : "view PR →"}
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
