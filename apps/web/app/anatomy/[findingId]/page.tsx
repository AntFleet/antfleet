import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadAnatomyBundle, type ProviderReasoning } from "@/lib/anatomy";
import { fetchHunkPair } from "@/lib/anatomy-fetcher";
import { redactSecrets } from "@/lib/disagreements";
import { formatRelativeTime } from "@/lib/receipts";
import { shortenRepoHash, shortenSha } from "@/lib/short-id";
import { CodeHunk } from "@/components/CodeHunk";
import { ThreadTemplate } from "@/components/ThreadTemplate";

export const dynamic = "force-dynamic";

const SITE_URL = "https://www.antfleet.dev";

type RouteParams = { findingId: string };

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "\u2026";
}

export async function generateMetadata({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { findingId } = await params;
  const bundle = await loadAnatomyBundle(findingId);
  if (bundle === null) {
    return { title: "AntFleet \u00b7 Anatomy not found" };
  }
  const pageUrl = `${SITE_URL}/anatomy/${encodeURIComponent(bundle.findingId)}`;
  return {
    title: `${bundle.severity} ${bundle.category}: ${truncate(bundle.title, 60)} \u2014 AntFleet anatomy`,
    description: `Both frontier models flagged this ${bundle.category} finding. Full reasoning, code samples, and fix diff.`,
    alternates: { canonical: pageUrl },
    openGraph: {
      type: "article",
      publishedTime: bundle.createdAt.toISOString(),
      modifiedTime: bundle.closedAt?.toISOString(),
    },
    twitter: { card: "summary_large_image" },
  };
}

export default async function AnatomyPage({ params }: { params: Promise<RouteParams> }) {
  const { findingId } = await params;
  const bundle = await loadAnatomyBundle(findingId);
  if (bundle === null) {
    notFound();
  }

  const now = new Date();
  const pageUrl = `${SITE_URL}/anatomy/${encodeURIComponent(bundle.findingId)}`;

  const hunks =
    bundle.source.owner.length > 0 && bundle.closureSha !== null
      ? await fetchHunkPair({
          owner: bundle.source.owner,
          repo: bundle.source.repo,
          installationId: bundle.source.installationId,
          prSha: bundle.source.prSha,
          closureSha: bundle.closureSha,
          file: bundle.source.file,
          lineStart: bundle.source.lineStart,
          lineEnd: bundle.source.lineEnd,
        })
      : null;

  return (
    <>
      <Hero bundle={bundle} now={now} />
      <SectionDivider />
      <VulnerableCode bundle={bundle} hunks={hunks} />
      <SectionDivider />
      <Reasoning bundle={bundle} />
      <SectionDivider />
      <Agreement bundle={bundle} />
      {bundle.closureSha !== null && (
        <>
          <SectionDivider />
          <FixCode bundle={bundle} hunks={hunks} />
        </>
      )}
      <SectionDivider />
      <ClosureMetadata bundle={bundle} now={now} />
      <SectionDivider />
      <section>
        <ContentWrap>
          <ThreadTemplate bundle={bundle} pageUrl={pageUrl} />
        </ContentWrap>
      </section>
      <SectionDivider />
      <CrossLinks bundle={bundle} />

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "TechArticle",
            headline: `${bundle.severity} ${bundle.category}: ${bundle.title}`,
            datePublished: bundle.createdAt.toISOString(),
            dateModified: bundle.closedAt?.toISOString() ?? bundle.createdAt.toISOString(),
            author: { "@type": "Organization", name: "AntFleet" },
            url: pageUrl,
            isPartOf: {
              "@type": "WebSite",
              name: "AntFleet",
              url: SITE_URL,
            },
          }).replace(/</g, "\\u003c"),
        }}
      />
    </>
  );
}

function ContentWrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6">{children}</div>;
}

function SectionDivider() {
  return <div className="border-t border-[var(--color-line)] my-16" />;
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-[var(--color-line-strong)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
      {children}
    </span>
  );
}

type BundleType = NonNullable<Awaited<ReturnType<typeof loadAnatomyBundle>>>;
type HunksType = Awaited<ReturnType<typeof fetchHunkPair>>;

function Hero({ bundle, now }: { bundle: BundleType; now: Date }) {
  return (
    <section className="py-20 pb-12">
      <ContentWrap>
        <p className="font-mono text-xs text-[var(--color-ink-subtle)] mb-6 tracking-widest uppercase">
          Anatomy &middot; {bundle.findingId}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ink)] leading-snug">
          {redactSecrets(bundle.title)}
        </h1>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Badge>{bundle.severity}</Badge>
          <Badge>{bundle.category}</Badge>
          {bundle.closureSha !== null && <Badge>closed in {shortenSha(bundle.closureSha)}</Badge>}
        </div>
        <div className="mt-6 font-mono text-[11px] text-[var(--color-ink-subtle)] flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>repo {shortenRepoHash(bundle.repoHash)}</span>
          <span className="text-[var(--color-line-strong)]">&middot;</span>
          <span>PR #{bundle.prNumber}</span>
          <span className="text-[var(--color-line-strong)]">&middot;</span>
          <span>reviewed {formatRelativeTime(now, bundle.createdAt)}</span>
          {bundle.closedAt !== null && (
            <>
              <span className="text-[var(--color-line-strong)]">&middot;</span>
              <span>closed {formatRelativeTime(now, bundle.closedAt)}</span>
            </>
          )}
        </div>
      </ContentWrap>
    </section>
  );
}

function VulnerableCode({ bundle, hunks }: { bundle: BundleType; hunks: HunksType }) {
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
          The vulnerable code
        </h2>
        {bundle.source.file.length > 0 && (
          <p className="font-mono text-[11px] text-[var(--color-ink-muted)] mb-3">
            {bundle.source.file}:{bundle.source.lineStart}-{bundle.source.lineEnd}
          </p>
        )}
        {hunks?.vulnerable ? (
          <CodeHunk content={hunks.vulnerable.content} startLineNumber={bundle.source.lineStart} />
        ) : (
          <div className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] p-5">
            <p className="text-sm text-[var(--color-ink-muted)]">
              Code snippet unavailable.{" "}
              {bundle.closureCommentUrl !== null && (
                <a
                  href={bundle.closureCommentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-[var(--color-ink)] transition-colors"
                >
                  View on GitHub &rarr;
                </a>
              )}
            </p>
          </div>
        )}
      </ContentWrap>
    </section>
  );
}

function Reasoning({ bundle }: { bundle: BundleType }) {
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
          The reasoning
        </h2>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <ReasoningCard label="Opus" reasoning={bundle.reasoning.anthropic} />
          <ReasoningCard label="GPT-5" reasoning={bundle.reasoning.openai} />
        </div>
      </ContentWrap>
    </section>
  );
}

function ReasoningCard({
  label,
  reasoning,
}: {
  label: string;
  reasoning: ProviderReasoning | null;
}) {
  if (reasoning === null) {
    return (
      <div className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] p-5">
        <p className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-4">
          {label}
        </p>
        <p className="text-sm text-[var(--color-ink-muted)]">Output unavailable for this row.</p>
      </div>
    );
  }

  return (
    <article className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] p-5">
      <p className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-4">
        {label}
      </p>
      <h3 className="text-sm leading-snug text-[var(--color-ink)]">
        {redactSecrets(reasoning.title)}
      </h3>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Badge>{reasoning.severity}</Badge>
        <Badge>{reasoning.category}</Badge>
        {reasoning.confidence.length > 0 && <Badge>{reasoning.confidence}</Badge>}
      </div>
      {reasoning.evidence.length > 0 && (
        <ul className="mt-5 flex flex-col gap-1 font-mono text-xs">
          {reasoning.evidence.map((ev, i) => (
            <li key={i} className="text-[var(--color-ink)] break-words">
              {formatEvidencePath(ev)}
            </li>
          ))}
        </ul>
      )}
      {reasoning.reasoning.length > 0 && (
        <blockquote className="mt-5 border-l-2 border-[var(--color-line-strong)] pl-4 text-sm text-[var(--color-ink-muted)] leading-relaxed">
          {redactSecrets(reasoning.reasoning)}
        </blockquote>
      )}
      {reasoning.recommendation.length > 0 && (
        <div className="mt-5 text-sm text-[var(--color-ink-muted)] leading-relaxed">
          <p className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-1">
            Recommendation
          </p>
          <p>{redactSecrets(reasoning.recommendation)}</p>
        </div>
      )}
    </article>
  );
}

function Agreement({ bundle }: { bundle: BundleType }) {
  const shaShort = bundle.closureSha !== null ? shortenSha(bundle.closureSha) : null;
  return (
    <section>
      <ContentWrap>
        <div className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] p-6">
          <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-4">
            The agreement
          </h2>
          <p className="text-sm text-[var(--color-ink-muted)] max-w-xl leading-relaxed">
            Both frontier models flagged this within the same line range. AntFleet&apos;s unanimous
            gate fired &mdash; the finding posted on the PR.
            {shaShort !== null && (
              <>
                {" "}
                Closed in{" "}
                <code className="font-mono text-xs text-[var(--color-ink)]">{shaShort}</code>.
              </>
            )}
          </p>
        </div>
      </ContentWrap>
    </section>
  );
}

function FixCode({ bundle, hunks }: { bundle: BundleType; hunks: HunksType }) {
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
          The fix
        </h2>
        {hunks?.fix ? (
          <CodeHunk content={hunks.fix.content} startLineNumber={bundle.source.lineStart} />
        ) : (
          <div className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-bg-elevated)] p-5">
            <p className="text-sm text-[var(--color-ink-muted)]">
              Fix snippet unavailable.{" "}
              {bundle.closureCommentUrl !== null && (
                <a
                  href={bundle.closureCommentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-[var(--color-ink)] transition-colors"
                >
                  View on GitHub &rarr;
                </a>
              )}
            </p>
          </div>
        )}
      </ContentWrap>
    </section>
  );
}

function ClosureMetadata({ bundle, now }: { bundle: BundleType; now: Date }) {
  return (
    <section>
      <ContentWrap>
        <h2 className="text-xs font-mono uppercase tracking-widest text-[var(--color-ink-subtle)] mb-5">
          Closure
        </h2>
        <div className="flex flex-col gap-3 font-mono text-xs text-[var(--color-ink-muted)]">
          {bundle.closedAt !== null && <p>Closed {formatRelativeTime(now, bundle.closedAt)}</p>}
          {bundle.closureSha !== null && (
            <p>
              SHA: <span className="text-[var(--color-ink)]">{bundle.closureSha}</span>
            </p>
          )}
          {bundle.closureCommentUrl !== null && (
            <a
              href={bundle.closureCommentUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-[var(--color-ink)] transition-colors"
            >
              View closure receipt on GitHub &rarr;
            </a>
          )}
        </div>
      </ContentWrap>
    </section>
  );
}

function CrossLinks({ bundle }: { bundle: BundleType }) {
  return (
    <section className="pb-20">
      <ContentWrap>
        <div className="flex flex-col gap-3 font-mono text-xs">
          <a
            href={`/receipts/${encodeURIComponent(bundle.findingId)}`}
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline underline-offset-2 transition-colors"
          >
            view receipt &rarr;
          </a>
          <a
            href="/receipts"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline underline-offset-2 transition-colors"
          >
            all receipts &rarr;
          </a>
          <a
            href="/disagreements"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline underline-offset-2 transition-colors"
          >
            view disagreements &rarr;
          </a>
          <a
            href="/retro"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline underline-offset-2 transition-colors"
          >
            case studies &rarr;
          </a>
        </div>
      </ContentWrap>
    </section>
  );
}

function formatEvidencePath(ev: {
  path: string;
  startLine: number | null;
  endLine: number | null;
}): string {
  if (ev.startLine === null) return ev.path;
  if (ev.endLine === null || ev.endLine === ev.startLine) {
    return `${ev.path}:${ev.startLine}`;
  }
  return `${ev.path}:${ev.startLine}-${ev.endLine}`;
}
