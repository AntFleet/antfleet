import type { Metadata } from "next";

// Roadmap — operator-facing forward view. Two sections: the three
// goals that define AntFleet's edge (north star) and the four open
// decisions that need to be made before they're load-bearing
// commitments. Voice per AGENTS.md §15 (direct, technical, no
// marketing fluff). Comparisons to peer agents are positioning, not
// affiliation.

const LAST_UPDATED = "2026-05-17";

export const metadata: Metadata = {
  title: "AntFleet · Roadmap",
  description:
    "The three goals that define AntFleet's edge, and the four open decisions ahead of launch.",
};

export default function RoadmapPage() {
  return (
    <>
      <RoadmapHero />
      <SectionDivider />
      <NorthStarSection />
      <SectionDivider />
      <DecisionsSection />
      <SectionDivider />
      <CadenceSection />
    </>
  );
}

// ─── hero ───────────────────────────────────────────────────────────────────

function RoadmapHero() {
  return (
    <section className="py-20 pb-12">
      <ContentWrap>
        <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
          Roadmap · north star + open decisions
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug max-w-xl">
          Where AntFleet is going, and what we haven&apos;t yet decided.
        </h1>
        <p className="mt-5 text-base leading-relaxed text-[var(--color-ink-muted)] max-w-xl">
          The three goals below are the trust-substrate edge: compute efficiency, receipt density,
          and holder utility. The four decisions below them are the live questions — none yet
          locked, none worth committing to until the data says so. This page updates when a decision
          flips.
        </p>
      </ContentWrap>
    </section>
  );
}

// ─── three north-star goals ─────────────────────────────────────────────────

const NORTH_STAR = [
  {
    label: "01",
    title: "Compute efficiency",
    metric: "highest reviews-per-DIEM",
    description:
      "Work valuation divided by inference spend. AntFleet's natural edge — every dollar of compute produces a SHA-pinned, third-party-witnessed receipt. Other Liquid-tier autonomous agents don't post artifacts at this verifiability density.",
  },
  {
    label: "02",
    title: "Receipt density",
    metric: "most SHA-pinned outputs per day",
    description:
      "Every review and every closure receipt is a verifiable artifact on GitHub's event log. The page at /receipts is the running count; the goal is to grow it faster than any peer agent grows narrative volume. A tweet doesn't audit; a SHA does.",
  },
  {
    label: "03",
    title: "Holder utility",
    metric: "only Liquid agent whose token holders point it at code",
    description:
      "Tokenized autonomous agents typically reward holders with narrative, governance, or revenue share. AntFleet's intended utility is concrete: a holder can point the agent at a repository they care about. Real product, not just narrative.",
  },
] as const;

function NorthStarSection() {
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-8">
          North star · three goals
        </h2>
        <ol className="flex flex-col gap-10">
          {NORTH_STAR.map((g) => (
            <li key={g.label} className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-x-6 gap-y-2">
              <span className="font-mono text-xs text-[var(--color-ink-subtle)] tracking-widest">
                {g.label}
              </span>
              <div className="flex flex-col gap-2">
                <h3 className="text-base font-semibold text-[var(--color-ink)] leading-snug">
                  {g.title}
                </h3>
                <p className="font-mono text-xs text-[var(--color-ink-muted)]">{g.metric}</p>
                <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed">
                  {g.description}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </ContentWrap>
    </section>
  );
}

// ─── decisions ahead ────────────────────────────────────────────────────────

const DECISIONS = [
  {
    title: "Paid tier — private repos in DIEM",
    summary: "Open question: should private-repo customers pay the agent in DIEM directly?",
    pros: "Strengthens work valuation — every paid review is a priced artifact, denominated in the agent's own work-unit.",
    cons: 'Complicates the "agent has a monopoly over its own economy" story; introduces customer-facing token UX that may slow Phase 2 throughput.',
    state: "decide before launch · no commitment yet",
  },
  {
    title: "Receipt anchoring on-chain",
    summary:
      "Full finding on IPFS with hash anchored on-chain, or just the SHA pair (review SHA + closure SHA) on GitHub's event log?",
    pros: "On-chain anchoring is verifiable independent of GitHub; survives outages, repo deletions, account suspensions.",
    cons: "Cheap-vs-verifiable trade-off — IPFS pinning has ongoing cost; on-chain writes have per-receipt gas. The SHA pair alone is already third-party-witnessed if you trust GitHub's commit log.",
    state: "trade-off open · benchmark cost vs. user-perceived verifiability",
  },
  {
    title: "Constitution drift detector",
    summary:
      'Pre-commit hook that blocks merges when the agent\'s constitution drifts more than "30%" from the previous canonical version.',
    pros: "Keeps the agent's behavior stable across edits — every contributor sees a hard wall before drift compounds.",
    cons: 'Open question: what is the deterministic diff metric for "30%"? Has to be runnable unattended (no LLM-in-the-loop) so the hook can ship in CI.',
    state: "needs a deterministic metric · then it ships",
  },
  {
    title: "Two-model agreement with Venice in the slot",
    summary:
      "Replace one of the current Reviewer-fleet slots with Venice's frontier tier, and measure whether unanimous agreement with Claude Opus 4.7 holds at a noise-tolerable rate.",
    pros: "Diversifies the model stack beyond the current Anthropic + OpenAI duopoly. Aligns with the marketplace thesis where models compete on the agreement primitive.",
    cons: "Unanimous-rate has to clear the precision-not-coverage bar; a third voter that disagrees too often turns the agreement gate into a veto rather than a filter.",
    state: "method known · run the dogfood corpus against {opus, venice} before any roster change",
  },
] as const;

function DecisionsSection() {
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-8">
          Decisions ahead · open before launch
        </h2>
        <ol className="flex flex-col divide-y divide-[var(--color-line)] border-t border-b border-[var(--color-line)]">
          {DECISIONS.map((d, i) => (
            <li key={d.title} className="py-7 flex flex-col gap-3">
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-xs text-[var(--color-ink-subtle)] tracking-widest w-8 shrink-0">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="text-base font-semibold text-[var(--color-ink)] leading-snug">
                  {d.title}
                </h3>
              </div>
              <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed pl-11 max-w-xl">
                {d.summary}
              </p>
              <dl className="pl-11 grid grid-cols-1 gap-1.5">
                <DecisionRow term="for" body={d.pros} />
                <DecisionRow term="against" body={d.cons} />
                <DecisionRow term="state" body={d.state} />
              </dl>
            </li>
          ))}
        </ol>
      </ContentWrap>
    </section>
  );
}

function DecisionRow({ term, body }: { term: string; body: string }) {
  return (
    <div className="grid grid-cols-[5rem_1fr] gap-3 items-baseline">
      <dt className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
        {term}
      </dt>
      <dd className="text-sm text-[var(--color-ink-muted)] leading-relaxed">{body}</dd>
    </div>
  );
}

// ─── cadence / closing ──────────────────────────────────────────────────────

function CadenceSection() {
  return (
    <section className="pb-20">
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
          Cadence
        </h2>
        <p className="text-sm text-[var(--color-ink-muted)] leading-relaxed max-w-xl">
          We update this page when a decision flips — never to add aspirational items. The{" "}
          <a
            href="/changelog"
            className="underline underline-offset-2 text-[var(--color-ink)] hover:opacity-70 transition-opacity"
          >
            changelog
          </a>{" "}
          records what shipped; this page records what we&apos;re deliberately not committing to
          yet. If something on the decisions list has been here for more than two months without
          movement, it&apos;s probably the wrong question and should be retired rather than
          rephrased.
        </p>
        <p className="mt-4 font-mono text-xs text-[var(--color-ink-subtle)]">
          Last updated: {LAST_UPDATED}
        </p>
      </ContentWrap>
    </section>
  );
}

// ─── layout primitives (mirrors /policy and /architecture) ──────────────────

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="border-t border-[var(--color-line)] my-16" />;
}
