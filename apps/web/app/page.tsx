import { loadCurrentWeeklyFeature, type WeeklyFeatureRow } from "@/db/queries";
import { severityLabel, shortAddress } from "@/lib/agent-findings";
import { getGitHubAppInstallUrl } from "@/lib/install-url";
import { formatRelativeTime } from "@/lib/receipts";

// Sprint 4 — homepage now queries weekly_features for the receipt-of-the-week
// card. Skip static pre-render so the build doesn't query the prod DB before
// migrations 0014 have landed.
export const dynamic = "force-dynamic";

// ─── constants ──────────────────────────────────────────────────────────────

const RECEIPTS_URL = "/receipts";

// ─── shared layout primitives ───────────────────────────────────────────────

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="border-t border-[var(--color-line)] my-16" />;
}

// ─── receipt of the week ────────────────────────────────────────────────────

function ReceiptOfTheWeekCard({ feature }: { feature: WeeklyFeatureRow }) {
  const agentHref = `/agents/${feature.agentTokenAddress}`;
  const relative = formatRelativeTime(new Date(), feature.featuredAt);
  const summary = toPlaintextPreview(feature.summary, 200);

  return (
    <section className="py-20 pb-8">
      <ContentWrap>
        <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
          Receipt of the week
        </p>

        <article className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] px-5 py-6 sm:px-7 sm:py-7">
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={agentHref}
              className="font-mono text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] hover:underline underline-offset-2 transition-colors"
            >
              {feature.agentName} · {shortAddress(feature.agentTokenAddress)}
            </a>
            <span className="rounded-full border border-[var(--color-line-strong)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
              {severityLabel(feature.severity)}
            </span>
          </div>

          <h2 className="mt-5 max-w-2xl text-2xl sm:text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-tight">
            {feature.title}
          </h2>

          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-[var(--color-ink-muted)]">
            {summary}
          </p>

          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
            <a
              href={agentHref}
              className="inline-flex w-fit items-center gap-2 rounded-md bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] transition-opacity hover:opacity-80"
            >
              See full receipt →
            </a>
            <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
              Featured {relative}
            </span>
          </div>
        </article>
      </ContentWrap>
    </section>
  );
}

function toPlaintextPreview(markdown: string, maxChars: number): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= maxChars) return plain;
  return `${plain.slice(0, maxChars).trimEnd()}…`;
}

// ─── hero ────────────────────────────────────────────────────────────────────

function Hero({ installUrl }: { installUrl: string }) {
  return (
    <section className="py-20 pb-12">
      <ContentWrap>
        {/* label */}
        <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
          GitHub App · PR code review
        </p>

        <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight text-[var(--color-ink)] leading-[1.05] max-w-2xl">
          The trust layer for code written by agents.
        </h1>

        <p className="mt-6 text-base leading-relaxed text-[var(--color-ink-muted)] max-w-xl">
          Two independent frontier models review every PR. Agreement between them is the trust
          primitive — and every closed finding is pinned to a public, SHA-verifiable receipt on the
          PR that resolved it. The audit trail isn&apos;t in our database; it&apos;s on
          GitHub&apos;s event log, where anyone can check it.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <a
            href={installUrl}
            className="inline-flex items-center gap-2 rounded-md bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] transition-opacity hover:opacity-80"
          >
            Install GitHub App
          </a>
          <a
            href={RECEIPTS_URL}
            className="inline-flex items-center gap-2 rounded-md border border-[var(--color-line-strong)] px-4 py-2 text-sm font-medium text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-ink)] hover:border-[var(--color-ink)]"
          >
            View Receipts
          </a>
        </div>
      </ContentWrap>
    </section>
  );
}

// ─── proof: example receipt ──────────────────────────────────────────────────

function ProofSection() {
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-4">
          What a receipt looks like
        </h2>
        <p className="text-sm text-[var(--color-ink-muted)] mb-5 max-w-xl leading-relaxed">
          Every closed finding becomes a public comment on the original PR. The comment lives on
          GitHub&apos;s event log — not ours — so the timestamp, the closing commit SHA, and the
          accumulation over time are all third-party-witnessed. The receipts are the artifact.
        </p>

        {/* receipt render — styled as a GitHub-comment facsimile */}
        <div className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] overflow-hidden">
          {/* comment header bar */}
          <div className="flex items-center gap-2 border-b border-[var(--color-line)] px-4 py-2.5 bg-[var(--color-bg)]">
            <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
              antfleet-bot
            </span>
            <span className="text-[var(--color-line-strong)]">·</span>
            <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
              commented on PR #14
            </span>
            <span className="ml-auto rounded-full border border-[var(--color-line-strong)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-ink-subtle)]">
              automated
            </span>
          </div>

          {/* receipt body */}
          <div className="px-4 py-5">
            {/* heading */}
            <p className="font-mono text-sm font-semibold text-[var(--color-ink)] mb-3">
              AntFleet · finding{" "}
              <code className="rounded bg-[var(--color-line)] px-1.5 py-0.5 text-xs">
                83e79770-1
              </code>{" "}
              closed in{" "}
              <code className="rounded bg-[var(--color-line)] px-1.5 py-0.5 text-xs">1ee2fd9</code>
            </p>

            {/* badge row */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span className="rounded-full border border-[var(--color-line-strong)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
                Security
              </span>
              <span className="rounded-full border border-[var(--color-line-strong)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
                High
              </span>
            </div>

            {/* body text */}
            <p className="text-sm text-[var(--color-ink-muted)] mb-1">
              SQL injection in{" "}
              <code className="rounded bg-[var(--color-line)] px-1 py-0.5 font-mono text-xs text-[var(--color-ink)]">
                getOrder
              </code>{" "}
              handler
            </p>
            <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-4">
              apps/api/src/orders.ts:42–56
            </p>

            <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed mb-4">
              Originally flagged in the AntFleet review on PR #14. Both frontier models agreed
              independently. Receipt automated by the daily sweep.
            </p>

            {/* footer strip */}
            <div className="flex items-center gap-2 pt-3 border-t border-[var(--color-line)]">
              <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
                Closed 2026-05-17
              </span>
              <span className="text-[var(--color-line-strong)]">·</span>
              <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
                commit <span className="text-[var(--color-ink-muted)]">1ee2fd9</span>
              </span>
              <span className="text-[var(--color-line-strong)]">·</span>
              <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">
                sweeper v0.3
              </span>
            </div>
          </div>
        </div>

        <p className="mt-4 text-xs text-[var(--color-ink-subtle)] font-mono">
          ↳ example receipt — format is identical to what appears on your actual PRs
        </p>
      </ContentWrap>
    </section>
  );
}

// ─── feature grid ─────────────────────────────────────────────────────────────

const FEATURES = [
  {
    glyph: "◈",
    title: "Two frontier models",
    description: "Claude Opus 4.7 and GPT-5 review every PR independently, in parallel.",
  },
  {
    glyph: "∩",
    title: "Unanimous-only posting",
    description:
      "Only findings both models flag get posted. The agreement gate eliminates noise at the source.",
  },
  {
    glyph: "#",
    title: "SHA-pinned receipts",
    description:
      "Every closed finding is pinned to the resolving commit SHA — a public, verifiable artifact.",
  },
  {
    glyph: "↺",
    title: "Daily sweeper",
    description:
      "A cron sweep reconciles open findings against main each day and posts closure receipts automatically.",
  },
  {
    glyph: "◎",
    title: "Maintainer signal",
    description:
      "Reactions on posted findings are polled at 24 h, 7 d, and 30 d — real-world RLHF for future routing.",
  },
  {
    glyph: "⌥",
    title: "MIT foundation",
    description:
      "Built on clawpatch (MIT, openclaw). Permissive lineage. Full audit trail in UPSTREAM.md.",
  },
] as const;

function FeatureGrid() {
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-8">
          What it does
        </h2>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="flex flex-col gap-2">
              <span className="font-mono text-base text-[var(--color-ink-muted)]">{f.glyph}</span>
              <p className="text-sm font-semibold text-[var(--color-ink)]">{f.title}</p>
              <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed">
                {f.description}
              </p>
            </div>
          ))}
        </div>
      </ContentWrap>
    </section>
  );
}

// ─── how it works ─────────────────────────────────────────────────────────────

function HowItWorks() {
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-8">
          How it works
        </h2>

        <ol className="flex flex-col gap-10">
          {/* step 1 */}
          <li className="flex flex-col gap-3">
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-xs text-[var(--color-ink-subtle)] w-4 shrink-0">
                01
              </span>
              <h3 className="text-sm font-semibold text-[var(--color-ink)]">
                Install the GitHub App
              </h3>
            </div>
            <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed pl-7">
              Authorize AntFleet on any repo. No other setup — no config file, no CI yaml changes.
              The webhook is live on install.
            </p>
            <div className="pl-7">
              <CodeBlock lang="bash">
                {`# One-click install via GitHub App
# → grants: pull_requests: read, issues: write, contents: read`}
              </CodeBlock>
            </div>
          </li>

          {/* step 2 */}
          <li className="flex flex-col gap-3">
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-xs text-[var(--color-ink-subtle)] w-4 shrink-0">
                02
              </span>
              <h3 className="text-sm font-semibold text-[var(--color-ink)]">
                Open a PR — review runs automatically
              </h3>
            </div>
            <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed pl-7">
              On every PR open or synchronize event, the two frontier models review changed files in
              parallel. Only unanimous findings become a comment. Disagreements are silently
              dropped.
            </p>
            <div className="pl-7">
              <CodeBlock lang="text">
                {`[anthropic]  claude-opus-4-7   → 9 findings
[openai]     gpt-5             → 7 findings
[agreement]  unanimous gate    → 3 agreed
[post]       PR comment        ✓`}
              </CodeBlock>
            </div>
          </li>

          {/* step 3 */}
          <li className="flex flex-col gap-3">
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-xs text-[var(--color-ink-subtle)] w-4 shrink-0">
                03
              </span>
              <h3 className="text-sm font-semibold text-[var(--color-ink)]">
                Sweeper closes the loop daily
              </h3>
            </div>
            <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed pl-7">
              Every night at 06:00 UTC, the sweeper checks each open finding against main. When the
              code is gone, it posts a closure receipt comment on the original PR — SHA-pinned,
              automated, permanent.
            </p>
            <div className="pl-7">
              <CodeBlock lang="bash">
                {`# vercel.json cron schedule
"crons": [{ "path": "/api/cron/sweep", "schedule": "0 6 * * *" }]`}
              </CodeBlock>
            </div>
          </li>
        </ol>
      </ContentWrap>
    </section>
  );
}

// ─── code block ───────────────────────────────────────────────────────────────

function CodeBlock({ children, lang }: { children: string; lang?: string }) {
  return (
    <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-bg-elevated)] overflow-x-auto">
      {lang && (
        <div className="border-b border-[var(--color-line)] px-4 py-1.5">
          <span className="font-mono text-[10px] text-[var(--color-ink-subtle)] uppercase tracking-widest">
            {lang}
          </span>
        </div>
      )}
      <pre className="px-4 py-4 text-xs leading-relaxed text-[var(--color-ink-muted)] font-mono whitespace-pre overflow-x-auto">
        <code>{children}</code>
      </pre>
    </div>
  );
}

// ─── bottom CTA ───────────────────────────────────────────────────────────────

function BottomCta({ installUrl }: { installUrl: string }) {
  return (
    <section className="pb-20">
      <ContentWrap>
        <div className="border-t border-[var(--color-line-strong)] pt-12">
          <h2 className="text-xl font-semibold tracking-tight text-[var(--color-ink)] mb-3">
            Ready to start building a receipts trail?
          </h2>
          <p className="text-sm text-[var(--color-ink-muted)] mb-7 max-w-lg leading-relaxed">
            Install the GitHub App on any repo. The first receipt appears after the first PR is
            reviewed and closed.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={installUrl}
              className="inline-flex items-center gap-2 rounded-md bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] transition-opacity hover:opacity-80"
            >
              Install GitHub App
            </a>
            <a
              href={RECEIPTS_URL}
              className="inline-flex items-center gap-2 text-sm text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] transition-colors underline-offset-2"
            >
              View public receipts
            </a>
          </div>
        </div>
      </ContentWrap>
    </section>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default async function Home() {
  const feature = await loadCurrentWeeklyFeature();
  const installUrl = getGitHubAppInstallUrl();

  return (
    <>
      {feature !== null && (
        <>
          <ReceiptOfTheWeekCard feature={feature} />
          <SectionDivider />
        </>
      )}
      <Hero installUrl={installUrl} />
      <SectionDivider />
      <ProofSection />
      <SectionDivider />
      <FeatureGrid />
      <SectionDivider />
      <HowItWorks />
      <SectionDivider />
      <BottomCta installUrl={installUrl} />
    </>
  );
}
