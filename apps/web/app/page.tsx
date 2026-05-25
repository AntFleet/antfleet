import { loadCurrentWeeklyFeature, type WeeklyFeatureRow } from "@/db/queries";
import { severityLabel, shortAddress } from "@/lib/agent-findings";
import { getGitHubAppInstallUrl } from "@/lib/install-url";
import {
  getDepositAddress,
  getMinDepositUsdc,
  getPublicBaseUrl,
  getReviewPriceUsdc,
} from "@/lib/paywall/env";
import { formatRelativeTime, loadCrossRepoReceipts, type CrossRepoReceiptRow } from "@/lib/receipts";

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
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-6">
          Receipt of the week
        </h2>

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

// ─── latest upstream fix ──────────────────────────────────────────────────────

function LatestImpactCard({ row }: { row: CrossRepoReceiptRow }) {
  const arrowLabel = `AntFleet → ${row.upstreamOwner}/${row.upstreamRepo}`;
  const relative = formatRelativeTime(new Date(), row.mergedAt);

  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-6">
          Latest upstream fix
        </h2>

        <article className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] px-5 py-6 sm:px-7 sm:py-7">
          <p className="font-mono text-xs text-[var(--color-ink-muted)]">
            {arrowLabel} · PR #{row.upstreamPrNumber}
          </p>
          <p className="mt-3 text-sm text-[var(--color-ink-muted)] leading-relaxed">
            Merged at{" "}
            <span className="font-mono text-xs text-[var(--color-ink)]">
              {row.mergeSha.slice(0, 7)}
            </span>{" "}
            · {relative}
          </p>

          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
            <a
              href="/impact"
              className="inline-flex w-fit items-center gap-2 rounded-md bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] transition-opacity hover:opacity-80"
            >
              View all impact →
            </a>
            <a
              href={row.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[11px] text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)] transition-colors"
            >
              view PR on GitHub →
            </a>
          </div>
        </article>
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

// ─── agent signup prompt ──────────────────────────────────────────────────────

// Copy-pasteable instructions an autonomous agent can follow to walk the
// paywall state machine without any other docs. Pulls live config (prices,
// deposit address, base URL) from env so it stays in sync with the
// manifest at /.well-known/antfleet.json. Matches existing CodeBlock
// styling — no new framework or component library.
function AgentSignup({
  baseUrl,
  reviewPrice,
  minDeposit,
  depositAddress,
}: {
  baseUrl: string;
  reviewPrice: string;
  minDeposit: string;
  depositAddress: string | null;
}) {
  const depositLine =
    depositAddress === null
      ? "# DEPOSIT ADDRESS: not yet configured — see /.well-known/antfleet.json before sending"
      : `# DEPOSIT ADDRESS: ${depositAddress}`;
  const prompt = `# AntFleet agent signup loop
# Chain: Base mainnet (8453)  |  Token: USDC  |  Price: ${reviewPrice}  |  Min deposit: ${minDeposit}
${depositLine}

# 1. Create installation row + binding challenge
curl -sX POST ${baseUrl}/api/v1/installations \\
  -H 'content-type: application/json' \\
  -d '{"wallet_address":"0x..."}'
# → { installation_id, binding_challenge, next_step: { ... } }

# 2. Sign binding_challenge with EIP-191 (personal_sign)
#    and POST the signature
curl -sX POST ${baseUrl}/api/v1/installations/{id}/bind \\
  -H 'content-type: application/json' \\
  -d '{"signature":"0x..."}'

# 3. Send >= ${minDeposit} USDC on Base from the bound wallet
#    to the deposit address, then POST the tx hash
curl -sX POST ${baseUrl}/api/v1/installations/{id}/deposit \\
  -H 'content-type: application/json' \\
  -d '{"tx_hash":"0x..."}'

# 4. Install the GitHub App on the repo you want reviewed
#    (state param echoes back via the post-install redirect)
open 'https://github.com/apps/antfleet/installations/new?state={installation_id}'

# 5. Open a PR. Reviews draw down ${reviewPrice} per review.
#    Channel below price → x402 invoice comment on the PR;
#    top up and the next PR runs.`;

  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-6">
          Agent signup prompt
        </h2>
        <p className="text-sm leading-relaxed text-[var(--color-ink-muted)] max-w-xl mb-6">
          Paste this into an autonomous agent. It walks the paywall state machine end-to-end —
          create installation, bind wallet, fund channel, install the App — without any other docs.
          Machine-readable manifest at{" "}
          <a
            href="/.well-known/antfleet.json"
            className="text-[var(--color-ink)] underline underline-offset-2 hover:opacity-80"
          >
            /.well-known/antfleet.json
          </a>
          ; instructions in markdown at{" "}
          <a
            href="/llms.txt"
            className="text-[var(--color-ink)] underline underline-offset-2 hover:opacity-80"
          >
            /llms.txt
          </a>
          .
        </p>
        <CodeBlock lang="bash">{prompt}</CodeBlock>
      </ContentWrap>
    </section>
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
  const [feature, latestImpact] = await Promise.all([
    loadCurrentWeeklyFeature(),
    loadCrossRepoReceipts(1),
  ]);
  const installUrl = getGitHubAppInstallUrl();
  const baseUrl = getPublicBaseUrl();
  const reviewPrice = getReviewPriceUsdc();
  const minDeposit = getMinDepositUsdc();
  const depositAddress = getDepositAddress();

  return (
    <>
      <Hero installUrl={installUrl} />
      <SectionDivider />
      {feature !== null && (
        <>
          <ReceiptOfTheWeekCard feature={feature} />
          <SectionDivider />
        </>
      )}
      {latestImpact.recent.length > 0 && (
        <>
          <LatestImpactCard row={latestImpact.recent[0]!} />
          <SectionDivider />
        </>
      )}
      <FeatureGrid />
      <SectionDivider />
      <HowItWorks />
      <SectionDivider />
      <AgentSignup
        baseUrl={baseUrl}
        reviewPrice={reviewPrice}
        minDeposit={minDeposit}
        depositAddress={depositAddress}
      />
      <SectionDivider />
      <BottomCta installUrl={installUrl} />
    </>
  );
}
