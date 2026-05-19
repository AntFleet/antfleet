import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { findAgentByAddress } from "@/lib/agent-registry";
import { fetchIdentityFile, identityThreshold, loadDriftSnapshots } from "@/lib/identity-drift";

export const dynamic = "force-dynamic";

type RouteParams = { address: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { address } = await params;
  const agent = findAgentByAddress(address);
  return {
    title: agent === null ? "AntFleet · Agent not found" : `AntFleet · ${agent.name} drift`,
  };
}

export default async function DriftPage({ params }: { params: Promise<RouteParams> }) {
  const { address } = await params;
  const agent = findAgentByAddress(address);
  if (agent === null) notFound();
  const [identity, snapshots] = await Promise.all([
    fetchIdentityFile(agent),
    loadDriftSnapshots(agent.address),
  ]);
  const threshold = identity.ok
    ? identityThreshold(identity.parsed)
    : (snapshots.at(-1)?.threshold ?? 0.25);

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <a
        href={`/agents/${agent.address}`}
        className="font-mono text-xs text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)]"
      >
        agent / {agent.name}
      </a>
      <div className="mt-6 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-[var(--color-ink-subtle)]">
            Identity drift monitor
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-[var(--color-ink)]">
            {agent.name}
          </h1>
        </div>
        <div className="rounded-md border border-[var(--color-line)] px-4 py-3">
          <p className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
            declared threshold
          </p>
          <p className="mt-1 text-2xl font-semibold text-[var(--color-ink)]">
            {threshold.toFixed(2)}
          </p>
        </div>
      </div>

      <section className="mt-10 rounded-md border border-[var(--color-line)] bg-white p-5">
        <DriftChart snapshots={snapshots} threshold={threshold} />
      </section>

      <section className="mt-8">
        <h2 className="font-mono text-xs uppercase tracking-widest text-[var(--color-ink-subtle)]">
          Snapshots
        </h2>
        <div className="mt-4 divide-y divide-[var(--color-line)] border-y border-[var(--color-line)]">
          {snapshots.length === 0 ? (
            <p className="py-5 text-sm text-[var(--color-ink-muted)]">
              No drift snapshots recorded yet.
            </p>
          ) : (
            snapshots
              .slice(-12)
              .toReversed()
              .map((snapshot) => (
                <div
                  key={snapshot.commitSha}
                  className="grid gap-2 py-4 text-sm sm:grid-cols-[1fr_120px_120px]"
                >
                  <span className="font-mono text-[var(--color-ink)]">
                    {snapshot.commitSha.slice(0, 12)}
                  </span>
                  <span className="text-[var(--color-ink-muted)]">
                    {snapshot.driftScore.toFixed(3)}
                  </span>
                  <span className="text-[var(--color-ink-subtle)]">
                    {snapshot.commitTimestamp.toISOString().slice(0, 10)}
                  </span>
                </div>
              ))
          )}
        </div>
      </section>
    </main>
  );
}

function DriftChart({
  snapshots,
  threshold,
}: {
  snapshots: Array<{ commitSha: string; commitTimestamp: Date; driftScore: number }>;
  threshold: number;
}) {
  const width = 860;
  const height = 300;
  const pad = 32;
  const maxY = Math.max(1, threshold, ...snapshots.map((s) => s.driftScore));
  const points = snapshots.map((snapshot, index) => {
    const x =
      snapshots.length <= 1 ? pad : pad + (index / (snapshots.length - 1)) * (width - pad * 2);
    const y = height - pad - (snapshot.driftScore / maxY) * (height - pad * 2);
    return { x, y };
  });
  const line = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const thresholdY = height - pad - (threshold / maxY) * (height - pad * 2);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full"
      role="img"
      aria-label="Identity drift line chart"
    >
      <rect x="0" y="0" width={width} height={height} fill="#ffffff" />
      <line
        x1={pad}
        y1={thresholdY}
        x2={width - pad}
        y2={thresholdY}
        stroke="#d8d8de"
        strokeDasharray="6 6"
      />
      <text
        x={width - pad}
        y={Math.max(16, thresholdY - 8)}
        textAnchor="end"
        fontSize="11"
        fill="#8a8a94"
        fontFamily="monospace"
      >
        threshold {threshold.toFixed(2)}
      </text>
      {points.length > 1 && (
        <polyline points={line} fill="none" stroke="#0a0a0a" strokeWidth="2.5" />
      )}
      {points.map((point, index) => (
        <circle key={`${point.x}-${index}`} cx={point.x} cy={point.y} r="3" fill="#0a0a0a" />
      ))}
      <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="#ececef" />
      <line x1={pad} y1={pad} x2={pad} y2={height - pad} stroke="#ececef" />
    </svg>
  );
}
