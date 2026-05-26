import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AntFleet · Disagreement Methodology",
  description: "How AntFleet classifies and surfaces reviewer disagreements.",
};

export default function DisagreementMethodologyPage() {
  return (
    <>
      <section className="py-20 pb-12">
        <ContentWrap>
          <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
            Disagreement methodology
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug max-w-xl">
            We publish what we don&apos;t post.
          </h1>
          <p className="mt-8 text-sm text-[var(--color-ink-muted)] max-w-xl leading-relaxed">
            Every PR AntFleet reviews is read by two frontier models independently. The unanimous
            gate posts only findings both agree on. Everything else &mdash; solo flags from one model,
            severity mismatches, classification conflicts &mdash; is filtered out. This page explains
            how we classify and surface those filtered findings.
          </p>
        </ContentWrap>
      </section>

      <SectionDivider />
      <MethodologySection title="The taxonomy">
        <p>
          A solo finding means one model flagged something and the other didn&apos;t mention the
          file at all.
        </p>
        <p>
          A mismatched classification means both models flagged the same line range, but assigned a
          different severity or category.
        </p>
        <p>
          We don&apos;t classify overlapping-different-evidence yet: same range, same
          classification, but divergent explanations.
        </p>
      </MethodologySection>

      <SectionDivider />
      <MethodologySection title="The opt-in gate">
        <p>
          Disagreements use the same public boundary as receipts: the parent review must have{" "}
          <code className="font-mono text-xs text-[var(--color-ink)]">public_receipt = true</code>.
          Non-opted-in reviews stay off this surface.
        </p>
      </MethodologySection>

      <SectionDivider />
      <MethodologySection title="How the data is computed">
        <p>
          The archive is computed from{" "}
          <code className="font-mono text-xs text-[var(--color-ink)]">
            reviews.provider_responses
          </code>{" "}
          JSONB. IDs are deterministic, and there is no new persistence layer; every row is
          reproducible from the source review data.
        </p>
      </MethodologySection>

      <SectionDivider />
      <MethodologySection title="AI Scorecard methodology">
        <p>
          Every week, AntFleet publishes a scorecard comparing the two frontier models that
          power the unanimous gate. Scorecard data is computed from the same{" "}
          <code className="font-mono text-xs text-[var(--color-ink)]">
            reviews.provider_responses
          </code>{" "}
          JSONB used by receipts and disagreements.
        </p>
        <p>
          <strong className="text-[var(--color-ink)]">Sample gate:</strong> only reviews where{" "}
          <code className="font-mono text-xs text-[var(--color-ink)]">public_receipt = true</code>{" "}
          contribute. Non-opted-in installs never reach this surface.
        </p>
        <p>
          <strong className="text-[var(--color-ink)]">Date windows:</strong> weekly, Monday 00:00
          UTC through Sunday 23:59:59 UTC. Each scorecard also shows a 4-week rolling average
          alongside the per-week numbers. Weeks with no reviews are excluded from the rolling
          average (not interpolated).
        </p>
        <p>
          <strong className="text-[var(--color-ink)]">Immutability:</strong> once a weekly snapshot
          is published, it never changes &mdash; even if underlying reviews are backfilled, opt-in
          status changes, or finding_status rows are updated. Credibility requires stable
          historical numbers.
        </p>
        <p>
          <strong className="text-[var(--color-ink)]">Small-N caveat:</strong> with the current
          review rate (~2&ndash;5 reviews per day), per-week samples are small. The 4-week rolling
          average alongside per-week numbers mitigates noise. The first few weeks of scorecard data
          will be especially noisy.
        </p>
        <p>
          <strong className="text-[var(--color-ink)]">Cost limitations:</strong> patch generation
          cost (<code className="font-mono text-xs text-[var(--color-ink)]">cost_patch_usd</code>)
          is currently always 0 due to a Patch Agent v1.5 blocker. Estimated token-cost is shown
          where available via the review-level{" "}
          <code className="font-mono text-xs text-[var(--color-ink)]">cost_estimated_usd</code>.
        </p>
        <p>
          <strong className="text-[var(--color-ink)]">Reproducibility:</strong> the aggregator
          at{" "}
          <code className="font-mono text-xs text-[var(--color-ink)]">
            apps/web/lib/scorecard.ts
          </code>{" "}
          is{" "}
          <a
            href="https://github.com/AntFleet/antfleet-core"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-ink)] underline underline-offset-2"
          >
            open source
          </a>
          . Same code path as{" "}
          <code className="font-mono text-xs text-[var(--color-ink)]">
            /api/v1/installations/&#123;id&#125;/review
          </code>
          .
        </p>
      </MethodologySection>

      <SectionDivider />
      <MethodologySection title="Why we publish them" last>
        <p>
          We publish what we don&apos;t post. The unanimous gate filters PR comments down to
          findings both frontier models agree on; this page shows the public, opted-in findings that
          gate filtered out.
        </p>
        <p className="mt-8">
          <a
            href="/disagreements"
            className="font-mono text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline underline-offset-2 transition-colors"
          >
            ← back to all disagreements
          </a>
        </p>
      </MethodologySection>
    </>
  );
}

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="border-t border-[var(--color-line)] my-16" />;
}

function MethodologySection({
  title,
  children,
  last = false,
}: {
  title: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <section className={last ? "pb-20" : undefined}>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
          {title}
        </h2>
        <div className="flex flex-col gap-4 text-sm text-[var(--color-ink-muted)] max-w-xl leading-relaxed">
          {children}
        </div>
      </ContentWrap>
    </section>
  );
}
