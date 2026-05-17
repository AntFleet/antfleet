import type { Metadata } from "next";
import { loadFleetActivity, type FleetActivityEvent } from "@/db/queries";
import { formatRelativeTime } from "@/lib/receipts";

// Agent activity feed — live ops dashboard for the fleet. Aggregate
// counters are privacy-safe by construction (just integers across all
// installs). The per-event stream gates on reviews.public_receipt = true
// — non-opted-in installs never surface in the visible feed even though
// their counts contribute to the aggregates.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Activity · AntFleet",
  description:
    "Live ops feed for the AntFleet fleet — recent reviews, agreed findings, closure receipts, and reaction signals.",
};

export default async function ActivityPage() {
  const data = await loadFleetActivity();
  const now = new Date();

  return (
    <>
      <Hero
        lastSweepAt={data.lastSweepAt}
        lastReceiptAt={data.lastReceiptAt}
        now={now}
      />
      <SectionDivider />
      <WindowsSection windows={data.windows} />
      <SectionDivider />
      <AgentRoster lastSweepAt={data.lastSweepAt} lastReceiptAt={data.lastReceiptAt} now={now} />
      <SectionDivider />
      <EventStream events={data.events} now={now} />
    </>
  );
}

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="border-t border-[var(--color-line)] my-16" />;
}

function Hero({
  lastSweepAt,
  lastReceiptAt,
  now,
}: {
  lastSweepAt: Date | null;
  lastReceiptAt: Date | null;
  now: Date;
}) {
  // Pick the most recent of the two as the "last activity" stamp — the
  // fleet is doing things on either signal.
  const candidates = [lastSweepAt, lastReceiptAt].filter(
    (d): d is Date => d !== null,
  );
  const lastActivity =
    candidates.length === 0
      ? null
      : candidates.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));

  return (
    <section className="py-20 pb-12">
      <ContentWrap>
        <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
          Activity · the fleet, live
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug max-w-xl">
          What the agents are doing.
        </h1>
        <p className="mt-5 text-base leading-relaxed text-[var(--color-ink-muted)] max-w-xl">
          Counts below cover every install. The event stream below shows
          only repos opted in to public receipts — non-opted-in activity
          contributes to the numbers but stays off this page.
        </p>
        <div className="mt-6 flex flex-wrap items-baseline gap-x-6 gap-y-2 font-mono text-[11px] text-[var(--color-ink-subtle)]">
          <span>
            last sweep ·{" "}
            <span className="text-[var(--color-ink-muted)]">
              {lastSweepAt === null ? "—" : formatRelativeTime(now, lastSweepAt)}
            </span>
          </span>
          <span className="text-[var(--color-line-strong)]">·</span>
          <span>
            last receipt ·{" "}
            <span className="text-[var(--color-ink-muted)]">
              {lastReceiptAt === null ? "—" : formatRelativeTime(now, lastReceiptAt)}
            </span>
          </span>
          {lastActivity !== null && (
            <>
              <span className="text-[var(--color-line-strong)]">·</span>
              <span>
                next scheduled sweep · <span className="text-[var(--color-ink-muted)]">06:00 UTC daily</span>
              </span>
            </>
          )}
        </div>
      </ContentWrap>
    </section>
  );
}

function WindowsSection({
  windows,
}: {
  windows: {
    last24h: { reviewsRun: number; findingsAgreed: number; receiptsClosed: number; reactionsObserved: number };
    last7d: { reviewsRun: number; findingsAgreed: number; receiptsClosed: number; reactionsObserved: number };
    allTime: { reviewsRun: number; findingsAgreed: number; receiptsClosed: number; reactionsObserved: number };
  };
}) {
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-8">
          By the numbers
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-[var(--color-line)] font-mono text-[11px] text-[var(--color-ink-subtle)] uppercase tracking-widest">
                <th className="text-left py-2 pr-6 font-normal"></th>
                <th className="text-right py-2 pr-6 font-normal">last 24h</th>
                <th className="text-right py-2 pr-6 font-normal">last 7d</th>
                <th className="text-right py-2 font-normal">all-time</th>
              </tr>
            </thead>
            <tbody>
              <CountRow
                label="reviews run"
                row24={windows.last24h.reviewsRun}
                row7={windows.last7d.reviewsRun}
                rowAll={windows.allTime.reviewsRun}
              />
              <CountRow
                label="findings agreed"
                row24={windows.last24h.findingsAgreed}
                row7={windows.last7d.findingsAgreed}
                rowAll={windows.allTime.findingsAgreed}
              />
              <CountRow
                label="receipts closed"
                row24={windows.last24h.receiptsClosed}
                row7={windows.last7d.receiptsClosed}
                rowAll={windows.allTime.receiptsClosed}
              />
              <CountRow
                label="reactions observed"
                row24={windows.last24h.reactionsObserved}
                row7={windows.last7d.reactionsObserved}
                rowAll={windows.allTime.reactionsObserved}
                last
              />
            </tbody>
          </table>
        </div>
      </ContentWrap>
    </section>
  );
}

function CountRow({
  label,
  row24,
  row7,
  rowAll,
  last,
}: {
  label: string;
  row24: number;
  row7: number;
  rowAll: number;
  last?: boolean;
}) {
  return (
    <tr className={last ? undefined : "border-b border-[var(--color-line)]"}>
      <td className="py-3 pr-6 text-[var(--color-ink-muted)]">{label}</td>
      <td className="py-3 pr-6 text-right font-mono tabular-nums text-[var(--color-ink)]">
        {row24.toLocaleString()}
      </td>
      <td className="py-3 pr-6 text-right font-mono tabular-nums text-[var(--color-ink)]">
        {row7.toLocaleString()}
      </td>
      <td className="py-3 text-right font-mono tabular-nums text-[var(--color-ink)]">
        {rowAll.toLocaleString()}
      </td>
    </tr>
  );
}

const AGENT_ROSTER = [
  {
    name: "Reviewer · Claude Opus 4.7",
    kind: "language model",
    role: "Reads changed files, returns structured findings.",
    cadenceSource: "perReview" as const,
  },
  {
    name: "Reviewer · GPT-5",
    kind: "language model",
    role: "Independent second review on every PR.",
    cadenceSource: "perReview" as const,
  },
  {
    name: "Agreement Gate",
    kind: "deterministic",
    role: "Emits only the findings both reviewers flagged.",
    cadenceSource: "perReview" as const,
  },
  {
    name: "Sweeper",
    kind: "deterministic",
    role: "Compares review SHA to main HEAD, closes findings when the file changed.",
    cadenceSource: "sweep" as const,
  },
  {
    name: "Reaction Poller",
    kind: "deterministic",
    role: "Re-fetches each posted comment at 24h / 7d / 30d for implicit RLHF signal.",
    cadenceSource: "sweep" as const,
  },
  {
    name: "Webhook Receiver",
    kind: "deterministic",
    role: "HMAC verify, stub-row insert, dispatch to the after()-scheduled review.",
    cadenceSource: "perReview" as const,
  },
];

function AgentRoster({
  lastSweepAt,
  lastReceiptAt,
  now,
}: {
  lastSweepAt: Date | null;
  lastReceiptAt: Date | null;
  now: Date;
}) {
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-8">
          Active agents
        </h2>
        <ul className="flex flex-col divide-y divide-[var(--color-line)] border-t border-b border-[var(--color-line)]">
          {AGENT_ROSTER.map((agent) => {
            const lastSeen =
              agent.cadenceSource === "sweep"
                ? lastSweepAt ?? lastReceiptAt
                : lastReceiptAt ?? lastSweepAt;
            return (
              <li
                key={agent.name}
                className="grid grid-cols-1 gap-1 py-4 sm:grid-cols-[1fr_140px_120px] sm:gap-6 sm:items-baseline"
              >
                <div>
                  <p className="text-sm font-semibold text-[var(--color-ink)]">{agent.name}</p>
                  <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed">{agent.role}</p>
                </div>
                <p className="font-mono text-[11px] text-[var(--color-ink-subtle)] uppercase tracking-widest sm:text-right">
                  {agent.kind}
                </p>
                <p className="font-mono text-[11px] text-[var(--color-ink-subtle)] sm:text-right">
                  {lastSeen === null ? "no signal yet" : `last seen ${formatRelativeTime(now, lastSeen)}`}
                </p>
              </li>
            );
          })}
        </ul>
        <p className="mt-4 font-mono text-[11px] text-[var(--color-ink-subtle)]">
          ↳ &quot;last seen&quot; for per-review agents derives from the most recent receipt; for sweep agents from the last sweep run.
        </p>
      </ContentWrap>
    </section>
  );
}

function EventStream({
  events,
  now,
}: {
  events: FleetActivityEvent[];
  now: Date;
}) {
  return (
    <section className="pb-20">
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
          Event stream
        </h2>
        <p className="text-sm text-[var(--color-ink-muted)] mb-8 max-w-xl leading-relaxed">
          Most recent fleet events from opted-in repos. Reviews, agreed
          findings, and closure receipts merged chronologically.
        </p>

        {events.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--color-line-strong)] p-8 text-center">
            <p className="text-sm text-[var(--color-ink)] mb-2">No public events yet.</p>
            <p className="text-sm text-[var(--color-ink-muted)] max-w-md mx-auto leading-relaxed">
              Either the fleet is just-started, or no opted-in repos have activity. Aggregates above cover all installs.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--color-line)] border-t border-b border-[var(--color-line)]">
            {events.map((event, i) => (
              <li key={i}>
                <EventRow event={event} now={now} />
              </li>
            ))}
          </ul>
        )}
      </ContentWrap>
    </section>
  );
}

function EventRow({ event, now }: { event: FleetActivityEvent; now: Date }) {
  const kindMeta = kindMetaFor(event.kind);
  const repoLabel = `repo ${event.repoHash.slice(0, 8)}`;
  const relative = formatRelativeTime(now, event.ts);
  const body = bodyFor(event);
  const href = event.kind === "review_completed" ? null : `/receipts/${encodeURIComponent(event.kind === "finding_agreed" ? event.findingId : event.kind === "finding_closed" ? event.findingId : "")}`;

  const content = (
    <div className="flex flex-col gap-1 py-4 sm:flex-row sm:items-start sm:gap-6">
      <div className="flex items-center gap-2 sm:w-40 sm:shrink-0">
        <KindBadge label={kindMeta.label} tone={kindMeta.tone} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[var(--color-ink)] leading-snug">{body}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
          <span>{repoLabel}</span>
          {event.kind === "review_completed" && (
            <>
              <span className="text-[var(--color-line-strong)]">·</span>
              <span>PR #{event.prNumber}</span>
            </>
          )}
          <span className="text-[var(--color-line-strong)]">·</span>
          <span>{relative}</span>
        </div>
      </div>
    </div>
  );

  if (href !== null) {
    return (
      <a href={href} className="block hover:bg-[var(--color-bg-elevated)] -mx-3 px-3 rounded-md transition-colors">
        {content}
      </a>
    );
  }
  return content;
}

function KindBadge({
  label,
  tone,
}: {
  label: string;
  tone: "ink" | "muted" | "subtle";
}) {
  const colorClass =
    tone === "ink"
      ? "text-[var(--color-ink)]"
      : tone === "muted"
        ? "text-[var(--color-ink-muted)]"
        : "text-[var(--color-ink-subtle)]";
  return (
    <span
      className={`rounded-full border border-[var(--color-line-strong)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${colorClass}`}
    >
      {label}
    </span>
  );
}

function kindMetaFor(kind: FleetActivityEvent["kind"]): {
  label: string;
  tone: "ink" | "muted" | "subtle";
} {
  switch (kind) {
    case "review_completed":
      return { label: "review", tone: "subtle" };
    case "finding_agreed":
      return { label: "agreed", tone: "muted" };
    case "finding_closed":
      return { label: "closed", tone: "ink" };
  }
}

function bodyFor(event: FleetActivityEvent): string {
  switch (event.kind) {
    case "review_completed":
      return "Reviewer Fleet completed a 2-of-2 review";
    case "finding_agreed":
      return `${event.category} · ${event.severity} — ${event.title}`;
    case "finding_closed":
      return `${event.category} · ${event.severity} — ${event.title}${event.closureSha === null ? "" : ` (closed in ${event.closureSha.slice(0, 7)})`}`;
  }
}
