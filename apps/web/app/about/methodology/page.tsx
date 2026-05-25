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
