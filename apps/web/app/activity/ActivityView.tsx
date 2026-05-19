"use client";

import { useEffect, useState } from "react";
import { formatRelativeTime } from "@/lib/receipts";

// The "live" presentation layer for /activity. Receives an initial snapshot
// from the server component (rendered with server-side now()), then takes
// over on hydration: ticks LiveTimestamp every second, polls /api/activity
// every 60s to refresh counters + event stream in place.
//
// Server vs client now: server renders the initial paint with its own
// `new Date()` and passes that timestamp as initialNow. Client hydrates
// with the same value (preventing mismatch warnings), then immediately
// updates to its own now and starts the per-second tick.

// JSON-friendly shape — Dates serialize as ISO strings over fetch().
type ActivityWindowJson = {
  reviewsRun: number;
  findingsAgreed: number;
  receiptsClosed: number;
  reactionsObserved: number;
};

type OnboarderEventTypeJson =
  | "install_welcome"
  | "first_review_summary"
  | "public_receipts_enabled"
  | "public_receipts_disabled"
  | "check_in_7d"
  // partner_reply is captured in the DB but filtered out by the server
  // before serialization — per-customer raw content never surfaces on
  // /activity. Kept in the union for type symmetry with the DB layer.
  | "partner_reply";

type FleetActivityEventJson =
  | {
      kind: "review_completed";
      ts: string;
      repoHash: string;
      prNumber: number;
      owner: string | null;
      repo: string | null;
    }
  | {
      kind: "finding_agreed";
      ts: string;
      findingId: string;
      severity: string;
      category: string;
      title: string;
      repoHash: string;
      owner: string | null;
      repo: string | null;
    }
  | {
      kind: "finding_closed";
      ts: string;
      findingId: string;
      severity: string;
      category: string;
      title: string;
      closureSha: string | null;
      repoHash: string;
      owner: string | null;
      repo: string | null;
    }
  | {
      kind: "onboarder_action";
      ts: string;
      eventType: OnboarderEventTypeJson;
      repoHash: string;
      commentUrl: string | null;
    };

export type FleetActivityJson = {
  lastSweepAt: string | null;
  lastReceiptAt: string | null;
  lastOnboarderAt: string | null;
  lastReviewAt: string | null;
  windows: {
    last24h: ActivityWindowJson;
    last7d: ActivityWindowJson;
    allTime: ActivityWindowJson;
  };
  events: FleetActivityEventJson[];
};

const POLL_INTERVAL_MS = 60_000;

export function ActivityView({
  initial,
  initialNowIso,
}: {
  initial: FleetActivityJson;
  initialNowIso: string;
}) {
  const [data, setData] = useState<FleetActivityJson>(initial);
  // SSR uses initialNow; client switches to its own clock on mount so the
  // per-second tick starts. Until the first useEffect run, both server and
  // client agree on initialNow, preventing hydration mismatch.
  const [now, setNow] = useState<Date>(() => new Date(initialNowIso));
  const [polling, setPolling] = useState<"live" | "paused">("live");

  useEffect(() => {
    setNow(new Date());
    const tick = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      // Don't poll when the tab is backgrounded — saves DB load + battery.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        setPolling("paused");
        return;
      }
      setPolling("live");
      try {
        const res = await fetch("/api/activity", { cache: "no-store" });
        if (!res.ok) return;
        const fresh = (await res.json()) as FleetActivityJson;
        if (!cancelled) setData(fresh);
      } catch {
        // Silent — next poll retries. Surfacing fetch errors as UI noise
        // would itself look broken.
      }
    }
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <>
      <Hero
        lastSweepAt={data.lastSweepAt}
        lastReceiptAt={data.lastReceiptAt}
        now={now}
        polling={polling}
      />
      <SectionDivider />
      <WindowsSection windows={data.windows} />
      <SectionDivider />
      <AgentRoster
        lastSweepAt={data.lastSweepAt}
        lastReceiptAt={data.lastReceiptAt}
        lastOnboarderAt={data.lastOnboarderAt}
        lastReviewAt={data.lastReviewAt}
        now={now}
      />
      <SectionDivider />
      <EventStream events={data.events} now={now} />
    </>
  );
}

// ─── presentational pieces ──────────────────────────────────────────────────

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="border-t border-[var(--color-line)] my-16" />;
}

function LivePill({ polling }: { polling: "live" | "paused" }) {
  const dotColor = polling === "live" ? "bg-emerald-500" : "bg-[var(--color-ink-subtle)]";
  const label = polling === "live" ? "LIVE" : "PAUSED";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-line-strong)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-ink-muted)]">
      <span className="relative flex h-1.5 w-1.5">
        {polling === "live" && (
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full ${dotColor} opacity-75`}
          />
        )}
        <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${dotColor}`} />
      </span>
      {label}
    </span>
  );
}

function Hero({
  lastSweepAt,
  lastReceiptAt,
  now,
  polling,
}: {
  lastSweepAt: string | null;
  lastReceiptAt: string | null;
  now: Date;
  polling: "live" | "paused";
}) {
  return (
    <section className="py-20 pb-12">
      <ContentWrap>
        <div className="flex items-center gap-3 mb-6">
          <p className="font-mono text-xs text-[var(--color-ink-subtle)] tracking-widest uppercase">
            Activity · watching the fleet
          </p>
          <LivePill polling={polling} />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug max-w-xl">
          What the agents are doing.
        </h1>
        <p className="mt-5 text-base leading-relaxed text-[var(--color-ink-muted)] max-w-xl">
          Counts below cover every install and refresh every 60 seconds. The event stream shows only
          repos opted in to public receipts — non-opted-in activity contributes to the numbers but
          stays off this page.
        </p>
        <div className="mt-6 flex flex-wrap items-baseline gap-x-6 gap-y-2 font-mono text-[11px] text-[var(--color-ink-subtle)]">
          <span>
            last sweep ·{" "}
            <span className="text-[var(--color-ink-muted)] tabular-nums">
              {lastSweepAt === null ? "—" : formatRelativeTime(now, new Date(lastSweepAt))}
            </span>
          </span>
          <span className="text-[var(--color-line-strong)]">·</span>
          <span>
            last receipt ·{" "}
            <span className="text-[var(--color-ink-muted)] tabular-nums">
              {lastReceiptAt === null ? "—" : formatRelativeTime(now, new Date(lastReceiptAt))}
            </span>
          </span>
          <span className="text-[var(--color-line-strong)]">·</span>
          <span>
            next sweep · <span className="text-[var(--color-ink-muted)]">06:00 UTC daily</span>
          </span>
        </div>
      </ContentWrap>
    </section>
  );
}

function WindowsSection({ windows }: { windows: FleetActivityJson["windows"] }) {
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-8">
          Live counts · public-receipt installs only
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
  {
    name: "Onboarder",
    kind: "language model",
    role: "Welcomes new installs, frames the first review, owns public-receipts intake and 7-day check-in.",
    cadenceSource: "onboarder" as const,
  },
];

function AgentRoster({
  lastSweepAt,
  lastReceiptAt,
  lastOnboarderAt,
  lastReviewAt,
  now,
}: {
  lastSweepAt: string | null;
  lastReceiptAt: string | null;
  lastOnboarderAt: string | null;
  lastReviewAt: string | null;
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
            const lastSeenIso =
              agent.cadenceSource === "sweep"
                ? (lastSweepAt ?? lastReceiptAt)
                : agent.cadenceSource === "onboarder"
                  ? lastOnboarderAt
                  : // perReview agents tick whenever a review runs, not when
                    // a finding closes — so prefer lastReviewAt over the
                    // closure-based timestamps.
                    (lastReviewAt ?? lastReceiptAt ?? lastSweepAt);
            return (
              <li
                key={agent.name}
                className="grid grid-cols-1 gap-1 py-4 sm:grid-cols-[1fr_140px_120px] sm:gap-6 sm:items-baseline"
              >
                <div>
                  <p className="text-sm font-semibold text-[var(--color-ink)]">{agent.name}</p>
                  <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed">
                    {agent.role}
                  </p>
                </div>
                <p className="font-mono text-[11px] text-[var(--color-ink-subtle)] uppercase tracking-widest sm:text-right">
                  {agent.kind}
                </p>
                <p className="font-mono text-[11px] text-[var(--color-ink-subtle)] tabular-nums sm:text-right">
                  {lastSeenIso === null
                    ? "no signal yet"
                    : `last seen ${formatRelativeTime(now, new Date(lastSeenIso))}`}
                </p>
              </li>
            );
          })}
        </ul>
      </ContentWrap>
    </section>
  );
}

function EventStream({ events, now }: { events: FleetActivityEventJson[]; now: Date }) {
  return (
    <section className="pb-20">
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
          Event stream
        </h2>
        <p className="text-sm text-[var(--color-ink-muted)] mb-8 max-w-xl leading-relaxed">
          Most recent fleet events from opted-in repos. Reviews, agreed findings, and closure
          receipts merged chronologically.
        </p>

        {events.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--color-line-strong)] p-8 text-center">
            <p className="text-sm text-[var(--color-ink)] mb-2">No public events yet.</p>
            <p className="text-sm text-[var(--color-ink-muted)] max-w-md mx-auto leading-relaxed">
              Either the fleet is just-started, or no opted-in repos have activity. Aggregates above
              match what the public /receipts list can substantiate (public-receipt installs only).
            </p>
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--color-line)] border-t border-b border-[var(--color-line)]">
            {events.map((event) => (
              <li key={`${event.kind}-${eventKey(event)}-${event.ts}`}>
                <EventRow event={event} now={now} />
              </li>
            ))}
          </ul>
        )}
      </ContentWrap>
    </section>
  );
}

function eventKey(event: FleetActivityEventJson): string {
  switch (event.kind) {
    case "review_completed":
      return `${event.repoHash}-${event.prNumber}`;
    case "finding_agreed":
    case "finding_closed":
      return event.findingId;
    case "onboarder_action":
      return `${event.eventType}-${event.repoHash}`;
  }
}

function EventRow({ event, now }: { event: FleetActivityEventJson; now: Date }) {
  const kindMeta = kindMetaFor(event.kind);
  const relative = formatRelativeTime(now, new Date(event.ts));
  const body = bodyFor(event);
  const bodyHref =
    event.kind === "review_completed"
      ? null
      : event.kind === "onboarder_action"
        ? event.commentUrl
        : `/receipts/${encodeURIComponent(event.findingId)}`;

  // Repo label: GitHub link when owner/repo are present (publicReceipt rows
  // only, by query gate); hashed fallback otherwise to preserve the existing
  // privacy posture for private-repo events that surface aggregates.
  const hasRepoIdentity =
    (event.kind === "review_completed" ||
      event.kind === "finding_agreed" ||
      event.kind === "finding_closed") &&
    typeof event.owner === "string" &&
    typeof event.repo === "string";
  const repoText = hasRepoIdentity
    ? `${(event as { owner: string }).owner}/${(event as { repo: string }).repo}`
    : `repo ${event.repoHash.slice(0, 8)}`;
  const repoHref = hasRepoIdentity
    ? `https://github.com/${(event as { owner: string }).owner}/${(event as { repo: string }).repo}`
    : null;
  const prHref =
    event.kind === "review_completed" && hasRepoIdentity
      ? `https://github.com/${(event as { owner: string }).owner}/${(event as { repo: string }).repo}/pull/${event.prNumber}`
      : null;

  return (
    <div className="flex flex-col gap-1 py-4 sm:flex-row sm:items-start sm:gap-6">
      <div className="flex items-center gap-2 sm:w-40 sm:shrink-0">
        <KindBadge label={kindMeta.label} tone={kindMeta.tone} />
      </div>
      <div className="flex-1 min-w-0">
        {bodyHref === null ? (
          <p className="text-sm text-[var(--color-ink)] leading-snug">{body}</p>
        ) : (
          <a
            href={bodyHref}
            className="text-sm text-[var(--color-ink)] leading-snug hover:underline underline-offset-2"
          >
            {body}
          </a>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-ink-subtle)]">
          {repoHref === null ? (
            <span>{repoText}</span>
          ) : (
            <a
              href={repoHref}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[var(--color-ink)] hover:underline underline-offset-2 transition-colors"
            >
              {repoText}
            </a>
          )}
          {event.kind === "review_completed" && (
            <>
              <span className="text-[var(--color-line-strong)]">·</span>
              {prHref === null ? (
                <span>PR #{event.prNumber}</span>
              ) : (
                <a
                  href={prHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-[var(--color-ink)] hover:underline underline-offset-2 transition-colors"
                >
                  PR #{event.prNumber}
                </a>
              )}
            </>
          )}
          <span className="text-[var(--color-line-strong)]">·</span>
          <span className="tabular-nums">{relative}</span>
        </div>
      </div>
    </div>
  );
}

function KindBadge({ label, tone }: { label: string; tone: "ink" | "muted" | "subtle" }) {
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

function kindMetaFor(kind: FleetActivityEventJson["kind"]): {
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
    case "onboarder_action":
      return { label: "onboarder", tone: "muted" };
  }
}

function bodyFor(event: FleetActivityEventJson): string {
  switch (event.kind) {
    case "review_completed":
      return "Reviewer Fleet completed a 2-of-2 review";
    case "finding_agreed":
      return `${event.category} · ${event.severity} — ${event.title}`;
    case "finding_closed":
      return `${event.category} · ${event.severity} — ${event.title}${event.closureSha === null ? "" : ` (closed in ${event.closureSha.slice(0, 7)})`}`;
    case "onboarder_action":
      return onboarderBodyFor(event.eventType);
  }
}

function onboarderBodyFor(eventType: OnboarderEventTypeJson): string {
  switch (eventType) {
    case "install_welcome":
      return "Onboarder posted a welcome on a fresh install";
    case "first_review_summary":
      return "Onboarder framed a partner's first review";
    case "public_receipts_enabled":
      return "Onboarder enabled public receipts for a repo";
    case "public_receipts_disabled":
      return "Onboarder disabled public receipts for a repo";
    case "check_in_7d":
      return "Onboarder posted a 7-day check-in";
    case "partner_reply":
      // Filtered out server-side; this branch is unreachable in practice.
      return "Onboarder logged a partner reply";
  }
}
