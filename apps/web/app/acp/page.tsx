import type { Metadata } from "next";
import {
  ACP_REVIEW_DELIVERABLE_SCHEMA_ID,
  ACP_REVIEW_ERROR_SCHEMA_ID,
  ACP_REVIEW_REQUEST_SCHEMA_ID,
  ACP_TRADING_DISCLAIMER,
} from "@/lib/acp/review-contract";

export const metadata: Metadata = {
  title: "ACP offering · AntFleet",
  description:
    "Public PR Code Review through Virtuals ACP: two-model consensus findings, structured JSON deliverables, and public receipt URLs.",
};

const TAGS = ["code-review", "security", "receipts", "github", "acp", "agent-trust"] as const;

export default function AcpOfferingPage() {
  return (
    <>
      <section className="py-20 pb-12">
        <ContentWrap>
          <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
            Virtuals ACP · beta SLA
          </p>
          <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-[var(--color-ink)] leading-tight sm:text-5xl">
            Public PR Code Review
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-relaxed text-[var(--color-ink-muted)]">
            Hire AntFleet through ACP to review a public GitHub PR. Two independent frontier
            reviewers inspect the code; only findings they both agree on are returned; fixed
            findings become SHA-pinned public receipts.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href={ACP_REVIEW_REQUEST_SCHEMA_ID}
              className="inline-flex rounded-md bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] transition-opacity hover:opacity-80"
            >
              Request schema
            </a>
            <a
              href={ACP_REVIEW_DELIVERABLE_SCHEMA_ID}
              className="inline-flex rounded-md border border-[var(--color-line-strong)] px-4 py-2 text-sm font-medium text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]"
            >
              Deliverable schema
            </a>
          </div>
        </ContentWrap>
      </section>

      <SectionDivider />

      <section>
        <ContentWrap>
          <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-6">
            Listing facts
          </h2>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Fact label="Price" value="1.00 USDC flat per public PR" />
            <Fact label="Target" value="Public GitHub pull requests" />
            <Fact label="Delivery SLA" value="Target 10 minutes, hard SLA 30 minutes" />
            <Fact label="Receipt" value="/receipts/review/{review_id} at delivery" />
          </dl>
          <div className="mt-6 flex flex-wrap gap-2">
            {TAGS.map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-[var(--color-line-strong)] px-2.5 py-1 font-mono text-[11px] text-[var(--color-ink-subtle)]"
              >
                {tag}
              </span>
            ))}
          </div>
        </ContentWrap>
      </section>

      <SectionDivider />

      <section>
        <ContentWrap>
          <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-6">
            Contract artifacts
          </h2>
          <ul className="divide-y divide-[var(--color-line)] rounded-md border border-[var(--color-line)]">
            <SchemaLink href={ACP_REVIEW_REQUEST_SCHEMA_ID} label="review-request-v0.json" />
            <SchemaLink
              href={ACP_REVIEW_DELIVERABLE_SCHEMA_ID}
              label="review-deliverable-v0.json"
            />
            <SchemaLink href={ACP_REVIEW_ERROR_SCHEMA_ID} label="review-error-v0.json" />
          </ul>
          <p className="mt-5 max-w-2xl text-sm leading-relaxed text-[var(--color-ink-muted)]">
            Successful reviews return the deliverable schema. Validation, provider degradation,
            inaccessible repositories, and timeouts return the error schema instead; failed jobs are
            not encoded as successful deliverables.
          </p>
        </ContentWrap>
      </section>

      <SectionDivider />

      <section className="pb-20">
        <ContentWrap>
          <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-6">
            Boundary
          </h2>
          <p className="max-w-2xl text-sm leading-relaxed text-[var(--color-ink-muted)]">
            This website publishes schemas, copy, fixtures, and public receipt projections.
            Production ACP provider runtime, wallet integration, job handlers, queue workers, and
            ACP CLI/SDK wiring live in this AntFleet monorepo alongside the existing review worker.
            The reusable contract helpers remain available from{" "}
            <a
              href="https://github.com/AntFleet/antfleet-core"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--color-ink)] underline underline-offset-2 hover:opacity-70"
            >
              AntFleet/antfleet-core
            </a>
            , but the operational ACP adapter is part of the production web worker.
          </p>
          <p className="mt-5 max-w-2xl text-sm leading-relaxed text-[var(--color-ink-muted)]">
            {ACP_TRADING_DISCLAIMER}
          </p>
        </ContentWrap>
      </section>
    </>
  );
}

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="border-t border-[var(--color-line)] my-14" />;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-bg-elevated)] p-5">
      <dt className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">
        {label}
      </dt>
      <dd className="mt-2 text-sm font-medium text-[var(--color-ink)]">{value}</dd>
    </div>
  );
}

function SchemaLink({ href, label }: { href: string; label: string }) {
  return (
    <li>
      <a
        href={href}
        className="flex items-center justify-between gap-4 px-4 py-3 text-sm text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-ink)]"
      >
        <span>{label}</span>
        <span className="font-mono text-[11px] text-[var(--color-ink-subtle)]">json schema</span>
      </a>
    </li>
  );
}
