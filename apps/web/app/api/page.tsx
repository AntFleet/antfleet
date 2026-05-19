import type { Metadata } from "next";
import React from "react";

export const metadata: Metadata = {
  title: "API · AntFleet",
  description:
    "Public, read-only JSON for AntFleet's code-quality data layer under /api/v1.",
};

const endpoints = [
  [
    "GET /api/v1/findings",
    "list of all published findings, filterable by agent, repo, severity, and date.",
  ],
  ["GET /api/v1/findings/{finding_id}", "one finding by id."],
  ["GET /api/v1/agents", "the agents directory."],
  ["GET /api/v1/agents/{address}", "one agent with finding + drift summary."],
  ["GET /api/v1/agents/{address}/findings", "findings for one agent."],
  ["GET /api/v1/agents/{address}/drift", "drift snapshots for one agent."],
  ["GET /api/v1/stats", "aggregate counts (no caching, real-time)."],
] as const;

export default function ApiPage() {
  return (
    <>
      <Header />
      <SectionDivider />
      <WhatItIsSection />
      <SectionDivider />
      <EndpointsSection />
      <SectionDivider />
      <PaginationSection />
      <SectionDivider />
      <ExampleSection />
      <SectionDivider />
      <RateLimitSection />
      <SectionDivider />
      <VersioningSection />
      <SectionDivider />
      <CitationSection />
      <Footer />
    </>
  );
}

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="border-t border-[var(--color-line)] my-16" />;
}

function Header() {
  return (
    <section className="py-20 pb-12">
      <ContentWrap>
        <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
          Public API · v1
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug max-w-xl">
          AntFleet API
        </h1>
        <p className="mt-8 text-sm text-[var(--color-ink-muted)] max-w-xl leading-relaxed">
          Public, read-only JSON for AntFleet&apos;s code-quality data layer. Versioned.
          Rate-limited. Stable.
        </p>
      </ContentWrap>
    </section>
  );
}

function WhatItIsSection() {
  return (
    <DocSection title="What it is">
      <p>
        Every finding AntFleet publishes — investigations on launchpad agents, drift snapshots, the
        agents directory — is exposed as paginated JSON under /api/v1. Downstream dashboards, Dune
        workspaces, ecosystem watchers, and operator tooling can read AntFleet as a data source
        without scraping.
      </p>
      <p>
        The contract under /api/v1 is frozen. Breaking changes ship at /api/v2. Additive changes —
        new optional fields, new endpoints, new query parameters — ship in-place and never remove
        what was there.
      </p>
    </DocSection>
  );
}

function EndpointsSection() {
  return (
    <DocSection title="Endpoints">
      <dl className="grid grid-cols-1 border-t border-[var(--color-line)] sm:grid-cols-[minmax(0,16rem)_1fr]">
        {endpoints.map(([path, description]) => (
          <div
            key={path}
            className="grid grid-cols-1 gap-2 border-b border-[var(--color-line)] py-4 sm:col-span-2 sm:grid-cols-subgrid sm:gap-6"
          >
            <dt className="font-mono text-[12px] leading-relaxed text-[var(--color-ink)]">
              {path}
            </dt>
            <dd className="text-sm leading-relaxed text-[var(--color-ink-muted)]">
              {description}
            </dd>
          </div>
        ))}
      </dl>
    </DocSection>
  );
}

function PaginationSection() {
  return (
    <DocSection title="Pagination + filters">
      <p>
        Lists return {"{ \"data\": [...], \"next_cursor\": \"string|null\" }"}. Pass
        ?cursor=&lt;value&gt; to fetch the next page. limit defaults to 20, max 100. Cursors are
        opaque — pass them back exactly as received.
      </p>
      <p>
        Filter parameters on /findings: agent_token_address, repo_full_name, severity (info, low,
        med, high), since (ISO date).
      </p>
    </DocSection>
  );
}

function ExampleSection() {
  return (
    <DocSection title="Example">
      <PreBlock>curl https://antfleet.dev/api/v1/findings?severity=high&amp;limit=5</PreBlock>
      <PreBlock>
        {`{
  "data": [
    {
      "finding_id": "feelocker-selector-2026-05-18",
      "agent_token_address": "0xB3D7e0c3C39A1D3F1B304663065A2F83Ddf56d8e",
      "agent_name": "autonomopoly",
      "repo_full_name": "Liquid-Protocol-Ops/agent-autonomopoly",
      "title": "FeeLocker selector mismatch …",
      "severity": "high",
      "summary": "…",
      "evidence": "…",
      "upstream_pr_url": null,
      "upstream_merged_sha": null,
      "published_at": "2026-05-18T12:34:56.000Z"
    }
  ],
  "next_cursor": null
}`}
      </PreBlock>
    </DocSection>
  );
}

function RateLimitSection() {
  return (
    <DocSection title="Rate limit">
      <p>60 requests per 60 seconds per IP, across all /api/v1 paths combined.</p>
      <p>
        The 61st request returns 429 with a Retry-After header. No authentication; no per-partner
        bypass.
      </p>
    </DocSection>
  );
}

function VersioningSection() {
  return (
    <DocSection title="Versioning">
      <p>
        /api/v1 is stable. Adding optional fields, endpoints, or query parameters is non-breaking
        and ships in-place. Removing or renaming a field, changing sort order, or changing default
        behaviour is breaking and ships at /api/v2. The OpenAPI document at /api/v1/openapi.json is
        the canonical machine-readable contract.
      </p>
    </DocSection>
  );
}

function CitationSection() {
  return (
    <DocSection title="How to cite">
      <p>AntFleet findings are stable artefacts. Cite them by finding_id:</p>
      <PreBlock>https://antfleet.dev/api/v1/findings/&lt;finding_id&gt;</PreBlock>
      <p>
        Linking to the human surface (https://antfleet.dev/agents/&lt;address&gt;) is fine for
        prose. The API URL is the form analysts should embed in dashboards and notebooks.
      </p>
    </DocSection>
  );
}

function Footer() {
  return (
    <footer className="pb-20">
      <ContentWrap>
        <a
          href="/api/v1/openapi.json"
          className="font-mono text-xs text-[var(--color-ink-muted)] underline underline-offset-2 hover:text-[var(--color-ink)] transition-colors"
        >
          openapi 3.1 specification ↗
        </a>
      </ContentWrap>
    </footer>
  );
}

function DocSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <ContentWrap>
        <h2 className="mb-6 font-mono text-xs uppercase tracking-widest text-[var(--color-ink-subtle)]">
          {title}
        </h2>
        <div className="flex flex-col gap-4 text-sm leading-relaxed text-[var(--color-ink-muted)]">
          {children}
        </div>
      </ContentWrap>
    </section>
  );
}

function PreBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="mt-2 mb-5 overflow-x-auto rounded-md border border-[var(--color-line)] bg-[var(--color-bg-elevated)] px-4 py-3 font-mono text-[12px] leading-snug text-[var(--color-ink)]">
      <code>{children}</code>
    </pre>
  );
}
