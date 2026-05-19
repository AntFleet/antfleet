import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchIdentityFile, identityThreshold } from "@/lib/identity-drift";
import { findAgentByAddress } from "@/lib/agent-registry";

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
    title: agent === null ? "AntFleet · Agent not found" : `AntFleet · ${agent.name} constitution`,
  };
}

export default async function ConstitutionPage({ params }: { params: Promise<RouteParams> }) {
  const { address } = await params;
  const agent = findAgentByAddress(address);
  if (agent === null) notFound();
  const identity = await fetchIdentityFile(agent);

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
            Constitution inspector
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-[var(--color-ink)]">
            {agent.name}
          </h1>
        </div>
        {identity.ok && (
          <div className="rounded-md border border-[var(--color-line)] px-4 py-3">
            <p className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
              drift threshold
            </p>
            <p className="mt-1 text-2xl font-semibold text-[var(--color-ink)]">
              {identityThreshold(identity.parsed).toFixed(2)}
            </p>
          </div>
        )}
      </div>

      {!identity.ok ? (
        <div className="mt-10 rounded-md border border-[var(--color-line)] bg-[var(--color-bg-elevated)] p-6">
          <p className="text-sm text-[var(--color-ink-muted)]">
            identity file unavailable, last fetched {identity.fetchedAt.toISOString()}
          </p>
        </div>
      ) : (
        <div className="mt-10 grid gap-4 md:grid-cols-2">
          {/* TODO when N>=2 agents: add a cross-agent constitution diff view. */}
          {Object.entries(identity.parsed).map(([key, value]) => (
            <ConstitutionCard
              key={key}
              name={key}
              value={value}
              emphasized={key === "what_the_agent_will_not_do"}
            />
          ))}
        </div>
      )}
    </main>
  );
}

function ConstitutionCard({
  name,
  value,
  emphasized,
}: {
  name: string;
  value: unknown;
  emphasized: boolean;
}) {
  return (
    <section
      className={`rounded-md border p-5 ${
        emphasized
          ? "border-[var(--color-ink)] bg-[var(--color-ink)] text-white md:col-span-2"
          : "border-[var(--color-line)] bg-white text-[var(--color-ink)]"
      }`}
    >
      <h2
        className={`font-mono text-xs uppercase tracking-widest ${emphasized ? "text-white/70" : "text-[var(--color-ink-subtle)]"}`}
      >
        {name}
      </h2>
      <pre
        className={`mt-4 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed ${emphasized ? "text-white" : "text-[var(--color-ink-muted)]"}`}
      >
        {formatValue(value)}
      </pre>
    </section>
  );
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
