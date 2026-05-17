import type { Metadata } from "next";

// Architecture page — agent-centered explainer per the §15 brand discipline
// (Stripe + Linear feel) plus the "agent run project" framing. Boxes are
// agents (named actors), arrows are handoffs. No marketing fluff — the
// purpose is to let an eng-lead buyer reverse-engineer the trust mechanic
// in 90 seconds without reading the codebase.

export const metadata: Metadata = {
  title: "Architecture · AntFleet",
  description:
    "How the AntFleet fleet works — the agents, the review pipeline, the sweep loop, the receipt anatomy.",
};

export default function ArchitecturePage() {
  return (
    <>
      <Hero />
      <SectionDivider />
      <AgentsSection />
      <SectionDivider />
      <ReviewPipelineSection />
      <SectionDivider />
      <SweepLoopSection />
      <SectionDivider />
      <OnboarderLifecycleSection />
      <SectionDivider />
      <ReceiptAnatomySection />
    </>
  );
}

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="border-t border-[var(--color-line)] my-16" />;
}

function Hero() {
  return (
    <section className="py-20 pb-12">
      <ContentWrap>
        <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
          Architecture · the fleet
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug max-w-xl">
          AntFleet is operated by a small fleet of agents.
        </h1>
        <p className="mt-5 text-base leading-relaxed text-[var(--color-ink-muted)] max-w-xl">
          Two of them are reviewer-fleet language models (Claude Opus 4.7,
          GPT-5). A third — Onboarder — owns the partner-facing lifecycle.
          The rest are deterministic workers: a webhook receiver, an
          agreement gate, a daily sweeper, a reaction poller. Together they
          manufacture the receipts you see on{" "}
          <a
            href="/receipts"
            className="underline underline-offset-2 text-[var(--color-ink)] hover:opacity-70 transition-opacity"
          >
            /receipts
          </a>
          . This page is the operator&apos;s diagram.
        </p>
      </ContentWrap>
    </section>
  );
}

// ─── Agents inventory ────────────────────────────────────────────────────────

const AGENTS = [
  {
    name: "Webhook Receiver",
    kind: "deterministic",
    role: "Listens at /api/github/webhook. Verifies HMAC signature. Inserts a stub review row. Dispatches the heavy work to the after()-scheduled review pipeline.",
    runs: "on every pull_request open / synchronize / reopen event",
  },
  {
    name: "Reviewer · Claude Opus 4.7",
    kind: "language model",
    role: "Reads the changed files. Returns a structured findings list — title, severity, category, evidence, reasoning.",
    runs: "in parallel with the GPT-5 reviewer on each PR event",
  },
  {
    name: "Reviewer · GPT-5",
    kind: "language model",
    role: "Same contract as the Claude reviewer. Two independent providers; no shared prompt cache; no cross-talk.",
    runs: "in parallel with the Claude reviewer on each PR event",
  },
  {
    name: "Agreement Gate",
    kind: "deterministic",
    role: "Compares both reviewer outputs. Emits only the findings both agents flagged on overlapping evidence. Silence is the correct output when there is no unanimous overlap.",
    runs: "once per review, immediately after both reviewers return",
  },
  {
    name: "Sweeper",
    kind: "deterministic",
    role: "For every open finding, fetches main HEAD and compares against the review commit. If the evidence file appears in the changed-files set, marks the finding closed at the new SHA and posts a closure receipt comment on the PR.",
    runs: "daily at 06:00 UTC; can be fired on demand by an operator",
  },
  {
    name: "Reaction Poller",
    kind: "deterministic",
    role: "Re-fetches each posted review comment at the 24h / 7d / 30d marks. Persists maintainer reactions (thumbs-up / down / heart / rocket / etc.) as implicit RLHF signal for future routing.",
    runs: "daily as part of the sweeper pass",
  },
  {
    name: "Onboarder",
    kind: "language model",
    role: "Owns the partner-facing lifecycle. Posts a model-authored welcome on a fresh install, frames the partner's first review, reads agent@antfleet.dev for public-receipts opt-in, and posts a 7-day reaction-tally check-in.",
    runs: "on installation.created webhook, on the first PR per install, on inbound email at agent@antfleet.dev, and on a 7-day cron",
  },
] as const;

function AgentsSection() {
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-8">
          The agents
        </h2>
        <ul className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          {AGENTS.map((agent) => (
            <li
              key={agent.name}
              className="rounded-md border border-[var(--color-line)] bg-[var(--color-bg-elevated)] p-5"
            >
              <div className="flex items-center justify-between gap-3 mb-2">
                <p className="text-sm font-semibold text-[var(--color-ink)]">{agent.name}</p>
                <KindBadge kind={agent.kind} />
              </div>
              <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed">{agent.role}</p>
              <p className="mt-3 font-mono text-[11px] text-[var(--color-ink-subtle)]">
                runs · {agent.runs}
              </p>
            </li>
          ))}
        </ul>
      </ContentWrap>
    </section>
  );
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <span className="rounded-full border border-[var(--color-line-strong)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] whitespace-nowrap">
      {kind}
    </span>
  );
}

// ─── Review pipeline diagram ────────────────────────────────────────────────

function ReviewPipelineSection() {
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-8">
          The review pipeline
        </h2>
        <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed max-w-xl mb-8">
          Each PR event triggers one pass through this pipeline. The agents on
          the left are stateless workers; the row on the right is the durable
          artifact that gets written to Postgres and (when agreement happens)
          to GitHub.
        </p>

        <PipelineDiagram
          rows={[
            { actor: "Pull-request event", arrow: "↓", target: "Webhook Receiver" },
            { actor: "Webhook Receiver", arrow: "↓ verifies HMAC, inserts stub", target: "reviews row" },
            { actor: "Webhook Receiver", arrow: "↓ dispatches", target: "Reviewer Fleet (2 agents)" },
            { actor: "Reviewer · Claude Opus 4.7", arrow: "↓ findings[]", target: "Agreement Gate" },
            { actor: "Reviewer · GPT-5", arrow: "↓ findings[]", target: "Agreement Gate" },
            { actor: "Agreement Gate", arrow: "↓ unanimous only", target: "finding_status rows + PR comment" },
          ]}
        />

        <p className="mt-8 text-sm text-[var(--color-ink-muted)] leading-relaxed max-w-xl">
          The Agreement Gate is the trust primitive. A finding only crosses
          into the PR comment if both reviewers flagged the same code with
          overlapping evidence. Silence on a PR means &quot;no unanimous
          finding,&quot; not &quot;no findings at all&quot; — individual
          reviewer outputs are persisted to <code className="font-mono text-xs">reviews.provider_responses</code> for analysis but never posted.
        </p>
      </ContentWrap>
    </section>
  );
}

// ─── Sweep loop diagram ─────────────────────────────────────────────────────

function SweepLoopSection() {
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-8">
          The sweep loop
        </h2>
        <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed max-w-xl mb-8">
          A finding stays open in Postgres until the Sweeper detects that the
          flagged file changed on the repo&apos;s default branch. The closure
          mechanic is intentionally cheap — &quot;evidence file touched&quot;
          is a strong proxy for &quot;bug addressed&quot; on a corpus where
          unanimous findings are ~100% real.
        </p>

        <PipelineDiagram
          rows={[
            { actor: "Cron · 06:00 UTC daily", arrow: "↓", target: "Sweeper" },
            { actor: "Sweeper", arrow: "↓ loadSweepWork()", target: "open findings grouped by repo" },
            { actor: "Sweeper", arrow: "↓ per-repo: getRef + compareCommits", target: "changed-files set" },
            { actor: "Sweeper", arrow: "↓ if evidence file changed", target: "markFindingClosed + closure SHA" },
            { actor: "Sweeper", arrow: "↓ posts on original PR", target: "Closure receipt comment" },
            { actor: "Reaction Poller", arrow: "↓ at 24h / 7d / 30d", target: "maintainer_reactions rows" },
          ]}
        />

        <p className="mt-8 text-sm text-[var(--color-ink-muted)] leading-relaxed max-w-xl">
          The closure receipt comment is the artifact. It lives on
          GitHub&apos;s event log — third-party-witnessed — and it is what the
          public <a href="/receipts" className="underline underline-offset-2 text-[var(--color-ink)] hover:opacity-70 transition-opacity">/receipts</a> counter is counting.
        </p>
      </ContentWrap>
    </section>
  );
}

// ─── Onboarder lifecycle diagram ────────────────────────────────────────────

function OnboarderLifecycleSection() {
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-8">
          The Onboarder lifecycle
        </h2>
        <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed max-w-xl mb-8">
          Onboarder is the third language-model agent in the fleet. It owns
          everything partner-facing that isn&apos;t a PR review: the welcome
          on install, a one-time framing comment on the partner&apos;s first
          PR, and a 7-day check-in. Each action is structured tool output
          from <code className="font-mono text-xs">claude-opus-4-7</code> and
          persists a row in{" "}
          <code className="font-mono text-xs">onboarding_events</code> with
          the prompt, output, and GitHub artifact ids — the same audit shape
          as <code className="font-mono text-xs">reviews</code>.
        </p>

        <PipelineDiagram
          rows={[
            { actor: "installation.created webhook", arrow: "↓", target: "Webhook Receiver" },
            { actor: "Webhook Receiver", arrow: "↓ dispatches", target: "Onboarder · welcome" },
            { actor: "Onboarder · welcome", arrow: "↓ repos.get + LLM tool call", target: "issues.create on partner repo" },
            { actor: "(first PR per install)", arrow: "↓ after Reviewer posts", target: "Onboarder · first-review summary" },
            { actor: "Onboarder · first-review summary", arrow: "↓ LLM tool call", target: "issues.createComment on the PR" },
            { actor: "Cron · 06:00 UTC daily", arrow: "↓ alongside Sweeper", target: "Onboarder · check-in driver" },
            { actor: "Onboarder · check-in driver", arrow: "↓ for installs aged 7-8d", target: "Onboarder · 7-day check-in" },
            { actor: "Onboarder · 7-day check-in", arrow: "↓ LLM tool call", target: "issues.createComment on welcome issue" },
          ]}
        />

        <p className="mt-8 text-sm text-[var(--color-ink-muted)] leading-relaxed max-w-xl">
          The whole lifecycle is gated behind an{" "}
          <code className="font-mono text-xs">ONBOARDER_ENABLED</code> env
          flag — default off in every environment. Cutover is operator-
          controlled, not webhook-controlled: a fresh install on a repo with
          the flag off generates a server log line and nothing else.
          Idempotency is per-<code className="font-mono text-xs">(installation_id, owner, repo, event_type)</code>
          {" "}so a repeated webhook never produces a duplicate issue or
          comment.
        </p>
      </ContentWrap>
    </section>
  );
}

// Generic pipeline diagram — left column is the actor, middle column is the
// arrow/annotation, right column is the artifact or next actor. Renders as a
// dense, scannable grid; no SVG complexity, no client-side JS.
function PipelineDiagram({
  rows,
}: {
  rows: Array<{ actor: string; arrow: string; target: string }>;
}) {
  return (
    <div className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] p-5">
      <ol className="flex flex-col gap-1">
        {rows.map((r, i) => (
          <li
            key={i}
            className="grid grid-cols-1 gap-1 sm:grid-cols-[1fr_auto_1fr] sm:gap-4 sm:items-center"
          >
            <span className="font-mono text-xs text-[var(--color-ink)] sm:text-right">
              {r.actor}
            </span>
            <span className="font-mono text-[11px] text-[var(--color-ink-subtle)] sm:text-center">
              {r.arrow}
            </span>
            <span className="font-mono text-xs text-[var(--color-ink-muted)]">
              {r.target}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ─── Receipt anatomy ────────────────────────────────────────────────────────

function ReceiptAnatomySection() {
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-8">
          What is in a receipt
        </h2>
        <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed max-w-xl mb-8">
          A closure receipt is the artifact the Sweeper posts on the original
          PR when a finding closes. Every field below is either authored by
          AntFleet or third-party-witnessed by GitHub&apos;s event log. Nothing
          is rendered from a database we control alone.
        </p>

        <div className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] overflow-hidden">
          <div className="border-b border-[var(--color-line)] px-4 py-2.5 bg-[var(--color-bg)] flex items-center gap-2">
            <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
              antfleet[bot]
            </span>
            <span className="text-[var(--color-line-strong)]">·</span>
            <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
              commented on PR
            </span>
          </div>
          <div className="px-4 py-5 flex flex-col gap-4">
            <AnnotatedLine
              field="Heading"
              text="AntFleet · finding f1b5393a-0 closed in 4640404"
              witness="finding id = our DB · SHA = GitHub commit log"
            />
            <AnnotatedLine
              field="Category + Severity"
              text="Security · High"
              witness="emitted only when both reviewers agreed"
            />
            <AnnotatedLine
              field="Title"
              text="Health endpoint exposes operational details"
              witness="produced by the Reviewer Fleet at review time"
            />
            <AnnotatedLine
              field="Evidence path"
              text="apps/web/app/api/health/route.ts:5-11"
              witness="from the Reviewer Fleet output; verifiable in the PR diff"
            />
            <AnnotatedLine
              field="Attribution"
              text="Originally flagged in the AntFleet review · Receipt automated"
              witness="links to the original GitHub comment; you can click and read it"
            />
          </div>
        </div>
      </ContentWrap>
    </section>
  );
}

function AnnotatedLine({
  field,
  text,
  witness,
}: {
  field: string;
  text: string;
  witness: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-[120px_1fr] sm:gap-4">
      <p className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
        {field}
      </p>
      <div>
        <p className="text-sm text-[var(--color-ink)] font-mono">{text}</p>
        <p className="mt-1 text-xs text-[var(--color-ink-subtle)] italic">{witness}</p>
      </div>
    </div>
  );
}
