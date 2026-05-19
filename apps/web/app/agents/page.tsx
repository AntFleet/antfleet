import type { Metadata } from "next";
import {
  loadAgentIndex,
  loadFactoryLaunchIndex,
  type AgentIndexRow,
  type FactoryLaunchIndexRow,
} from "@/db/queries";
import { formatRelativeTime } from "@/lib/receipts";
import { severityLabel, shortAddress } from "@/lib/agent-findings";

// Agents index — one row per agent that has at least one investigative
// finding on file. Distinct from /receipts and /benchmarks: those rows are
// PR-bound; these are agent-bound. The v1 surface is intentionally minimal
// because there will only be a handful of agents to start.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AntFleet · Agents",
  description:
    "Investigative findings AntFleet has filed against running agents — protocol bugs, on-chain anomalies, and reproducible reads from Base.",
};

export default async function AgentsIndexPage() {
  const [agents, factoryStubs] = await Promise.all([loadAgentIndex(), loadFactoryLaunchIndex()]);
  const now = new Date();
  const totalCount = agents.length + factoryStubs.length;

  return (
    <>
      <AgentsHero count={totalCount} />
      <SectionDivider />
      <AgentsList rows={agents} now={now} />
      {factoryStubs.length > 0 && (
        <>
          <SectionDivider />
          <FactoryStubsList rows={factoryStubs} now={now} />
        </>
      )}
    </>
  );
}

function FactoryStubsList({ rows, now }: { rows: FactoryLaunchIndexRow[]; now: Date }) {
  return (
    <section className="pb-20">
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-2">
          Auto-stubs from Liquid factory
        </h2>
        <p className="text-sm text-[var(--color-ink-muted)] mb-6 max-w-xl leading-relaxed">
          On-chain agent deployments AntFleet detected via the Liquid Protocol factory. No
          investigative findings on file yet — the pre-launch benchmark fires automatically once the
          repo is discovered.
        </p>
        <ul className="flex flex-col divide-y divide-[var(--color-line)] border-t border-b border-[var(--color-line)]">
          {rows.map((r) => (
            <li key={r.tokenAddress}>
              <FactoryStubRow row={r} now={now} />
            </li>
          ))}
        </ul>
      </ContentWrap>
    </section>
  );
}

function FactoryStubRow({ row, now }: { row: FactoryLaunchIndexRow; now: Date }) {
  const href = `/agents/${row.tokenAddress}`;
  const relative = formatRelativeTime(now, row.deployedAt);
  const displayName = row.tokenSymbol ?? row.tokenName ?? shortAddress(row.tokenAddress);
  const statusBadge = (() => {
    switch (row.prelaunchStatus) {
      case "pending":
        return "looking for repo";
      case "benchmarking":
        return "benchmarking";
      case "published":
        return "verdict published";
      case "repo_not_found":
        return "no repo found";
      case "benchmark_failed":
        return "benchmark failed";
      default:
        return row.prelaunchStatus;
    }
  })();

  return (
    <a
      href={href}
      className="block hover:bg-[var(--color-bg-elevated)] -mx-3 px-3 rounded-md transition-colors"
    >
      <div className="flex flex-col gap-3 py-5 sm:flex-row sm:items-start sm:gap-6 group">
        <div className="flex flex-wrap items-center gap-2 sm:w-44 sm:shrink-0">
          <Badge>auto-stub</Badge>
          <Badge>{statusBadge}</Badge>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-[var(--color-ink)] leading-snug group-hover:underline underline-offset-2">
            {displayName}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
            <span>{shortAddress(row.tokenAddress)}</span>
            <span className="text-[var(--color-line-strong)]">·</span>
            <span>deployed {relative}</span>
          </div>
        </div>
        <span className="font-mono text-[11px] text-[var(--color-ink-subtle)] group-hover:text-[var(--color-ink)] transition-colors sm:shrink-0 sm:self-center">
          stub →
        </span>
      </div>
    </a>
  );
}

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="border-t border-[var(--color-line)] my-16" />;
}

function AgentsHero({ count }: { count: number }) {
  return (
    <section className="py-20 pb-12">
      <ContentWrap>
        <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
          Public investigations · updated live
        </p>

        <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug max-w-xl">
          Findings AntFleet has filed against running agents.
        </h1>

        <div className="mt-10 flex items-baseline gap-4">
          <p className="text-6xl font-mono font-semibold tracking-tight text-[var(--color-ink)] tabular-nums">
            {count.toLocaleString()}
          </p>
          <p className="text-sm text-[var(--color-ink-muted)]">
            {count === 1 ? "agent on file" : "agents on file"}
          </p>
        </div>

        <p className="mt-8 text-sm text-[var(--color-ink-muted)] max-w-xl leading-relaxed">
          Each row is an autonomous agent we have an open or closed investigation on. Click through
          for the full finding write-up — reproducible commands, evidence links, and the upstream PR
          if one has been opened. Findings are reproducible against Base mainnet at the time of
          publish; new state is verified live.
        </p>
        <p className="mt-3 text-xs text-[var(--color-ink-subtle)] max-w-xl leading-relaxed">
          Looking for PR-bound receipts instead?{" "}
          <a
            href="/receipts"
            className="underline underline-offset-2 hover:text-[var(--color-ink)] transition-colors"
          >
            /receipts
          </a>
          {" or "}
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

function AgentsList({ rows, now }: { rows: AgentIndexRow[]; now: Date }) {
  if (rows.length === 0) {
    return (
      <section className="pb-20">
        <ContentWrap>
          <div className="rounded-md border border-dashed border-[var(--color-line-strong)] p-8 text-center">
            <p className="text-sm text-[var(--color-ink)] mb-2">No agent findings yet.</p>
            <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed max-w-md mx-auto">
              The first row will appear once AntFleet publishes an investigation against a running
              autonomous agent.
            </p>
          </div>
        </ContentWrap>
      </section>
    );
  }

  return (
    <section className="pb-20">
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-6">
          Agents on file
        </h2>
        <ul className="flex flex-col divide-y divide-[var(--color-line)] border-t border-b border-[var(--color-line)]">
          {rows.map((r) => (
            <li key={r.agentTokenAddress}>
              <AgentRow row={r} now={now} />
            </li>
          ))}
        </ul>
      </ContentWrap>
    </section>
  );
}

function AgentRow({ row, now }: { row: AgentIndexRow; now: Date }) {
  const href = `/agents/${row.agentTokenAddress}`;
  const relative = formatRelativeTime(now, row.lastFindingAt);
  const findingLabel = `${row.findingCount} finding${row.findingCount === 1 ? "" : "s"}`;

  return (
    <a
      href={href}
      className="block hover:bg-[var(--color-bg-elevated)] -mx-3 px-3 rounded-md transition-colors"
    >
      <div className="flex flex-col gap-3 py-5 sm:flex-row sm:items-start sm:gap-6 group">
        <div className="flex flex-wrap items-center gap-2 sm:w-44 sm:shrink-0">
          <Badge>{findingLabel}</Badge>
          <Badge>{severityLabel(row.highestSeverity)}</Badge>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-[var(--color-ink)] leading-snug group-hover:underline underline-offset-2">
            {row.agentName}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
            <span>{shortAddress(row.agentTokenAddress)}</span>
            <span className="text-[var(--color-line-strong)]">·</span>
            <span>updated {relative}</span>
          </div>
        </div>
        <span className="font-mono text-[11px] text-[var(--color-ink-subtle)] group-hover:text-[var(--color-ink)] transition-colors sm:shrink-0 sm:self-center">
          findings →
        </span>
      </div>
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
